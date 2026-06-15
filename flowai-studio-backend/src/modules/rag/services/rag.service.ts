import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma.service';
import { CreateKnowledgeBaseDto } from '../dto/create-knowledge-base.dto';
import { UpdateKnowledgeBaseDto } from '../dto/update-knowledge-base.dto';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { PDFParse } from 'pdf-parse';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type EmbeddingProvider = 'ark' | 'qwen';

interface EmbeddingConfig {
  provider: EmbeddingProvider;
  apiKey?: string;
  baseUrl: string;
  model: string;
}

interface CodeChunk {
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
  startIndex: number;
  endIndex: number;
}

const WORKSPACE_ROOT = path.resolve(process.cwd(), '..');
const CODE_EXCLUDED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);
const CODE_EXCLUDED_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);
const DEFAULT_CODE_EXTENSIONS = [
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.prisma',
  '.scss',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
];

@Injectable()
export class RAGService {
  private readonly logger = new Logger(RAGService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  // 知识库管理
  async createKnowledgeBase(userId: string, createKnowledgeBaseDto: CreateKnowledgeBaseDto) {
    return this.prisma.knowledgeBase.create({
      data: {
        ...createKnowledgeBaseDto,
        userId,
      },
    });
  }

  async findKnowledgeBases(userId: string) {
    return this.prisma.knowledgeBase.findMany({
      where: { userId },
      include: { documents: { select: { id: true, name: true, size: true, createdAt: true, status: true } } },
    });
  }

  async findKnowledgeBaseById(userId: string, id: string) {
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id },
      include: { documents: true },
    });

    if (!kb) {
      throw new NotFoundException('Knowledge base not found');
    }

    if (kb.userId !== userId) {
      throw new BadRequestException('You do not have permission to access this knowledge base');
    }

    return kb;
  }

  async updateKnowledgeBase(userId: string, id: string, updateKnowledgeBaseDto: UpdateKnowledgeBaseDto) {
    const kb = await this.findKnowledgeBaseById(userId, id);

    return this.prisma.knowledgeBase.update({
      where: { id },
      data: updateKnowledgeBaseDto,
    });
  }

  async deleteKnowledgeBase(userId: string, id: string) {
    await this.findKnowledgeBaseById(userId, id);
    // 删除知识库
    await this.prisma.document.deleteMany({ where: { knowledgeBaseId: id } });
    return this.prisma.knowledgeBase.delete({ where: { id } });
  }



  // 文档管理
  async uploadDocument(userId: string, knowledgeBaseId: string, file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('请选择要上传的文件');
    }

    // 验证知识库存在且属于用户
    await this.findKnowledgeBaseById(userId, knowledgeBaseId);

    const mimeType = file.mimetype || 'application/octet-stream';
    const fileName = file.originalname || '';
    const lowerName = fileName.toLowerCase();
    const ext = lowerName.includes('.') ? lowerName.slice(lowerName.lastIndexOf('.')) : '';
    const isPdf = mimeType === 'application/pdf' || ext === '.pdf';
    const isTextExt = ['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yaml', '.yml'].includes(ext);
    const isTextLikeMime =
      mimeType.startsWith('text/') ||
      mimeType === 'application/json' ||
      mimeType === 'application/xml' ||
      mimeType === 'application/x-yaml' ||
      mimeType === 'application/octet-stream';

    if (!isPdf && !isTextLikeMime && !isTextExt) {
      throw new BadRequestException('当前仅支持上传 txt / md / json / pdf 等文件');
    }

    const contentBuffer =
      file.buffer ||
      (file.path ? fs.readFileSync(file.path) : undefined);

    if (!contentBuffer) {
      throw new BadRequestException('读取上传文件失败');
    }

    const content = isPdf
      ? await this.extractPdfText(contentBuffer)
      : contentBuffer.toString('utf-8');
    if (!content.trim()) {
      throw new BadRequestException('文档内容为空或当前格式暂不支持');
    }

    const chunks = await this.processDocumentContent(content);

    // 检查同名文件是否已存在
    const existingDoc = await this.prisma.document.findFirst({
      where: { name: file.originalname, knowledgeBaseId },
    });
    if (existingDoc) {
      throw new BadRequestException(`该知识库中已存在同名文件「${file.originalname}」，请重命名后重新上传`);
    }

    const document = await this.prisma.document.create({
      data: {
        name: file.originalname,
        content,
        mimeType,
        size: file.size || contentBuffer.length,
        status: 'completed',
        knowledgeBaseId,
      },
    });

    // 保存文档块
    await this.saveDocumentChunks(document.id, chunks);

    return document;
  }

  async getDocumentChunks(userId: string, documentId: string) {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { knowledgeBase: true },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    if (document.knowledgeBase.userId !== userId) {
      throw new BadRequestException('You do not have permission to access this document');
    }

    const chunks = await this.prisma.documentChunk.findMany({
      where: { documentId },
      orderBy: { chunkIndex: 'asc' },
      select: {
        id: true,
        content: true,
        chunkIndex: true,
        startIndex: true,
        endIndex: true,
        metadata: true,
        createdAt: true,
      },
    });

    return {
      documentId,
      documentName: document.name,
      totalChunks: chunks.length,
      chunks,
    };
  }

  async deleteDocument(userId: string, documentId: string) {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { knowledgeBase: true },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    if (document.knowledgeBase.userId !== userId) {
      throw new BadRequestException('You do not have permission to delete this document');
    }

    await this.prisma.documentChunk.deleteMany({ where: { documentId } });
    return this.prisma.document.delete({ where: { id: documentId } });
  }

  async importCodeRepository(userId: string, params: Record<string, any>) {
    const knowledgeBaseId = String(params?.knowledgeBaseId || '');
    if (!knowledgeBaseId) {
      throw new BadRequestException('knowledgeBaseId is required');
    }

    await this.findKnowledgeBaseById(userId, knowledgeBaseId);

    const repoPath = this.resolveLocalCodePath(params?.path || '.');
    const repoStat = fs.statSync(repoPath);
    if (!repoStat.isDirectory()) {
      throw new BadRequestException('path must be a directory');
    }

    const extensions = Array.isArray(params?.extensions) && params.extensions.length > 0
      ? params.extensions.map((ext: string) => ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`)
      : DEFAULT_CODE_EXTENSIONS;
    const maxFiles = Math.min(Number(params?.maxFiles || 30), 300);
    const maxFileBytes = Math.min(Number(params?.maxFileBytes || 120000), 500000);
    const chunkSize = Math.min(Number(params?.chunkSize || 2400), 4000);
    const chunkOverlap = Math.min(Number(params?.chunkOverlap || 300), Math.floor(chunkSize / 2));
    const documentName = params?.name || `代码仓库：${path.basename(repoPath)} (${new Date().toLocaleString('zh-CN')})`;

    const files = this.collectCodeFiles(repoPath, extensions, maxFiles, maxFileBytes);
    if (files.length === 0) {
      throw new BadRequestException('没有找到可导入的代码文件');
    }

    const chunks: CodeChunk[] = [];
    const fileSummaries: Array<{ path: string; size: number; chunks: number }> = [];
    let combinedContent = '';

    for (const file of files) {
      const relativePath = this.toDisplayPath(file);
      const content = fs.readFileSync(file, 'utf-8');
      const fileChunks = await this.processCodeFileContent(relativePath, content, chunkSize, chunkOverlap);
      chunks.push(...fileChunks);
      fileSummaries.push({ path: relativePath, size: Buffer.byteLength(content), chunks: fileChunks.length });
      combinedContent += `\n\n# ${relativePath}\n\n${content}`;
    }

    const existingDoc = await this.prisma.document.findFirst({
      where: { name: documentName, knowledgeBaseId },
    });
    if (existingDoc) {
      await this.prisma.documentChunk.deleteMany({ where: { documentId: existingDoc.id } });
      await this.prisma.document.delete({ where: { id: existingDoc.id } });
    }

    const document = await this.prisma.document.create({
      data: {
        name: documentName,
        content: combinedContent.trim(),
        mimeType: 'text/code-repository',
        size: Buffer.byteLength(combinedContent),
        status: 'completed',
        metadata: JSON.stringify({
          type: 'code_repository',
          root: this.toDisplayPath(repoPath),
          files: fileSummaries,
        }),
        knowledgeBaseId,
      },
    });

    await this.saveCodeChunks(document.id, chunks);

    return {
      document,
      importedFiles: files.length,
      chunks: chunks.length,
      root: this.toDisplayPath(repoPath),
      files: fileSummaries,
    };
  }

  // 检索
  async retrieve(query: string, knowledgeBaseId: string, topK?: number) {
    // 生成查询向量
    const startedAt = Date.now();
    const queryVector = await this.generateEmbedding(query);
    const limit = topK || Number(this.configService.get<string>('RAG_TOP_K') || 3);
    const embeddingMs = Date.now() - startedAt;

    // 获取该知识库下所有的文档块
    const allChunks = await this.prisma.documentChunk.findMany({
      where: {
        document: {
          knowledgeBaseId: knowledgeBaseId
        }
      },
      include: {
        document: {
          select: {
            name: true,
          },
        },
      },
    });
    const dbMs = Date.now() - startedAt - embeddingMs;

    if (queryVector.length === 0) {
      const fallbackChunks = this.keywordRetrieve(query, allChunks, limit);
      this.logger.warn(
        `RAG vector retrieval skipped because query embedding is empty; keyword fallback returned ${fallbackChunks.length}/${allChunks.length}`,
      );
      return fallbackChunks;
    }

    // 在内存中计算相似度 (针对 SQLite 的权宜之计)
    const scoredChunks = allChunks.map(chunk => {
      const chunkEmbedding = JSON.parse(chunk.embedding || '[]');
      const similarity = this.cosineSimilarity(queryVector, chunkEmbedding);
      return {
        id: chunk.id,
        content: chunk.content,
        documentId: chunk.documentId,
        documentName: chunk.document.name,
        chunkIndex: chunk.chunkIndex,
        metadata: this.parseChunkMetadata(chunk.metadata),
        similarity
      };
    });

    // 排序并取 TopK
    const vectorResults = scoredChunks
      .filter((chunk) => chunk.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    if (vectorResults.length > 0) {
      const expandedResults = await this.expandAdjacentCodeChunks(vectorResults);
      this.logger.log(
        `RAG retrieve in ${Date.now() - startedAt}ms: embedding=${embeddingMs}ms, db=${dbMs}ms, chunks=${allChunks.length}, returned=${expandedResults.length}`,
      );
      return expandedResults;
    }

    const fallbackChunks = this.keywordRetrieve(query, allChunks, limit);
    this.logger.warn(
      `RAG vector retrieval returned no positive scores; keyword fallback returned ${fallbackChunks.length}/${allChunks.length}`,
    );
    return fallbackChunks;
  }

  private keywordRetrieve(query: string, chunks: any[], limit: number) {
    const terms = Array.from(
      new Set(
        query
          .toLowerCase()
          .split(/[\s,，。.!！？?;；:：、"'“”‘’()[\]{}<>《》]+/)
          .map((term) => term.trim())
          .filter((term) => term.length >= 2),
      ),
    );

    return chunks
      .map((chunk) => {
        const content = chunk.content || '';
        const normalizedContent = content.toLowerCase();
        const keywordScore = terms.reduce((score, term) => {
          return normalizedContent.includes(term) ? score + 1 : score;
        }, 0);

        return {
          id: chunk.id,
          content,
          documentId: chunk.documentId,
          documentName: chunk.document?.name || '',
          chunkIndex: chunk.chunkIndex,
          metadata: this.parseChunkMetadata(chunk.metadata),
          similarity: keywordScore,
        };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  private parseChunkMetadata(metadata?: string | null): Record<string, any> | undefined {
    if (!metadata) return undefined;
    try {
      return JSON.parse(metadata);
    } catch {
      return undefined;
    }
  }

  private async expandAdjacentCodeChunks(results: any[]) {
    const expanded = [...results];
    const seenIds = new Set(expanded.map((chunk) => chunk.id));

    for (const result of results) {
      if (result.metadata?.type !== 'code') continue;

      const adjacentChunks = await this.prisma.documentChunk.findMany({
        where: {
          documentId: result.documentId,
          chunkIndex: {
            in: [result.chunkIndex + 1],
          },
        },
        include: {
          document: {
            select: {
              name: true,
            },
          },
        },
      });

      for (const chunk of adjacentChunks) {
        if (seenIds.has(chunk.id)) continue;
        seenIds.add(chunk.id);
        expanded.push({
          id: chunk.id,
          content: chunk.content,
          documentId: chunk.documentId,
          documentName: chunk.document.name,
          chunkIndex: chunk.chunkIndex,
          metadata: this.parseChunkMetadata(chunk.metadata),
          similarity: result.similarity,
        });
      }
    }

    return expanded.sort((a, b) => {
      if (a.documentId === b.documentId) {
        return a.chunkIndex - b.chunkIndex;
      }
      return b.similarity - a.similarity;
    });
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length || vecA.length === 0) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    
    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    return isNaN(similarity) ? 0 : similarity;
  }

  // 文档处理
  private async processDocumentContent(content: string): Promise<{ content: string; embedding: number[] }[]> {
    const chunkSize = Number(this.configService.get<string>('RAG_CHUNK_SIZE') || 1000);
    const chunkOverlap = Number(this.configService.get<string>('RAG_CHUNK_OVERLAP') || 100);
    const chunks = this.splitText(content, chunkSize, chunkOverlap).slice(0, 8);

    const chunksWithEmbeddings = await Promise.all(
      chunks.map(async (chunk) => {
        const embedding = await this.generateEmbedding(chunk);
        return { content: chunk, embedding };
      })
    );

    return chunksWithEmbeddings;
  }

  // 文本分块
  private splitText(text: string, chunkSize: number, overlap: number): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      chunks.push(text.substring(start, end));
      start += chunkSize - overlap;
    }

    return chunks;
  }

  private async processCodeFileContent(
    relativePath: string,
    content: string,
    chunkSize: number,
    overlap: number,
  ): Promise<CodeChunk[]> {
    const rawChunks = this.splitText(content, chunkSize, overlap);
    const codeChunks: CodeChunk[] = [];

    for (let index = 0; index < rawChunks.length; index += 1) {
      const chunk = rawChunks[index];
      const startIndex = this.findChunkStart(content, chunk, index === 0 ? 0 : codeChunks[index - 1].endIndex - overlap);
      const endIndex = startIndex + chunk.length;
      const startLine = this.countLines(content.slice(0, startIndex)) + 1;
      const endLine = this.countLines(content.slice(0, endIndex));
      const enrichedContent = [
        `文件：${relativePath}`,
        `行号：${startLine}-${endLine}`,
        '```',
        chunk,
        '```',
      ].join('\n');

      const embedding = await this.generateEmbedding(enrichedContent);
      codeChunks.push({
        content: enrichedContent,
        embedding,
        startIndex,
        endIndex,
        metadata: {
          type: 'code',
          path: relativePath,
          startLine,
          endLine,
        },
      });
    }

    return codeChunks;
  }

  private findChunkStart(content: string, chunk: string, fromIndex: number): number {
    const start = content.indexOf(chunk, Math.max(fromIndex, 0));
    return start >= 0 ? start : Math.max(fromIndex, 0);
  }

  private countLines(text: string): number {
    if (!text) return 0;
    return text.split(/\r?\n/).length - 1;
  }

  private async extractPdfText(buffer: Buffer): Promise<string> {
    let parser: PDFParse | undefined;
    try {
      parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      return (result.text || '').trim();
    } catch (error) {
      this.logger.warn(`PDF parse failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      throw new BadRequestException('PDF 解析失败，请确认文件未加密且包含可复制文本');
    } finally {
      await parser?.destroy();
    }
  }

  // 生成向量嵌入
  private async generateEmbedding(text: string): Promise<number[]> {
    const embeddingConfig = this.getEmbeddingConfig();

    if (!embeddingConfig.apiKey || embeddingConfig.apiKey.startsWith('your-')) {
      return [];
    }

    try {
      const isMultimodalEmbedding = embeddingConfig.model.includes('embedding-vision');
      const endpoint = isMultimodalEmbedding ? 'embeddings/multimodal' : 'embeddings';
      const input = isMultimodalEmbedding
        ? [{ type: 'text', text }]
        : text;

      const response = await axios.post(
        `${embeddingConfig.baseUrl}/${endpoint}`,
        {
          model: embeddingConfig.model,
          encoding_format: 'float',
          input,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${embeddingConfig.apiKey}`,
          },
          timeout: 10000,
        }
      );

      return response.data.data?.embedding || response.data.data?.[0]?.embedding || [];
    } catch (error) {
      this.logger.warn(`Embedding generation failed: ${this.formatEmbeddingError(error)}`);
      return [];
    }
  }

  private getEmbeddingConfig(): EmbeddingConfig {
    const provider = this.configService.get<EmbeddingProvider>('EMBEDDING_PROVIDER') || 'ark';
    const genericApiKey = this.getTrimmedConfig('EMBEDDING_API_KEY');
    const genericBaseUrl = this.getTrimmedConfig('EMBEDDING_BASE_URL');
    const genericModel = this.getTrimmedConfig('EMBEDDING_MODEL');

    if (provider === 'qwen') {
      return {
        provider,
        apiKey: genericApiKey || this.getTrimmedConfig('QWEN_API_KEY'),
        baseUrl: genericBaseUrl || this.getTrimmedConfig('QWEN_BASE_URL') || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: genericModel || this.getTrimmedConfig('QWEN_EMBEDDING_MODEL') || 'text-embedding-v3',
      };
    }

    return {
      provider: 'ark',
      apiKey: genericApiKey || this.getTrimmedConfig('ARK_API_KEY'),
      baseUrl: genericBaseUrl || this.getTrimmedConfig('ARK_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3',
      model: genericModel || this.getTrimmedConfig('ARK_EMBEDDING_MODEL') || 'doubao-embedding-text-240715',
    };
  }

  private getTrimmedConfig(key: string): string | undefined {
    return this.configService.get<string>(key)?.trim();
  }

  private formatEmbeddingError(error: unknown): string {
    if (!axios.isAxiosError(error)) {
      return error instanceof Error ? error.message : String(error);
    }

    const data = error.response?.data;
    const apiError = data?.error;
    if (apiError?.code === 'AuthenticationError' && apiError?.message?.includes('API key format is incorrect')) {
      return '火山方舟 API Key 格式不正确。请使用方舟控制台「API Key 管理」里生成的调用密钥，并更新 .env 中的 EMBEDDING_API_KEY/ARK_API_KEY。';
    }

    if (apiError?.code || apiError?.message) {
      return [apiError.code, apiError.message].filter(Boolean).join(': ');
    }

    return error.message;
  }

  // 保存文档块
  private async saveDocumentChunks(documentId: string, chunks: { content: string; embedding: number[] }[]) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) {
      throw new NotFoundException('Document not found');
    }

    await this.prisma.documentChunk.createMany({
      data: chunks.map((chunk, index) => ({
        documentId,
        content: chunk.content,
        embedding: JSON.stringify(chunk.embedding),
        chunkIndex: index,
        startIndex: 0,
        endIndex: chunk.content.length,
      })),
    });
  }

  private async saveCodeChunks(documentId: string, chunks: CodeChunk[]) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) {
      throw new NotFoundException('Document not found');
    }

    await this.prisma.documentChunk.createMany({
      data: chunks.map((chunk, index) => ({
        documentId,
        content: chunk.content,
        embedding: JSON.stringify(chunk.embedding),
        chunkIndex: index,
        startIndex: chunk.startIndex,
        endIndex: chunk.endIndex,
        metadata: JSON.stringify(chunk.metadata),
      })),
    });
  }

  private getAllowedCodeRoots(): string[] {
    const configuredRoots = this.configService.get<string>('LOCAL_CODE_ROOTS');
    const roots = configuredRoots
      ? configuredRoots.split(',').map((root) => root.trim()).filter(Boolean)
      : [os.homedir(), WORKSPACE_ROOT];

    return Array.from(new Set(roots.map((root) => path.resolve(root))));
  }

  private isInsideAllowedCodeRoots(resolvedPath: string): boolean {
    return this.getAllowedCodeRoots().some((root) => {
      return resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`);
    });
  }

  private resolveLocalCodePath(inputPath = '.'): string {
    const rawInput = String(inputPath || '.');
    const resolvedPath = path.isAbsolute(rawInput)
      ? path.resolve(rawInput)
      : path.resolve(WORKSPACE_ROOT, rawInput);

    if (!this.isInsideAllowedCodeRoots(resolvedPath)) {
      throw new BadRequestException('path must be inside local code roots');
    }

    return resolvedPath;
  }

  private toDisplayPath(absolutePath: string): string {
    if (absolutePath === WORKSPACE_ROOT || absolutePath.startsWith(`${WORKSPACE_ROOT}${path.sep}`)) {
      return path.relative(WORKSPACE_ROOT, absolutePath) || '.';
    }

    return absolutePath;
  }

  private collectCodeFiles(
    rootPath: string,
    extensions: string[],
    maxFiles: number,
    maxFileBytes: number,
  ): string[] {
    const files: string[] = [];
    const allowedExtensions = new Set(extensions.map((ext) => ext.toLowerCase()));

    const walk = (currentPath: string) => {
      if (files.length >= maxFiles) return;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(currentPath);
      } catch (error) {
        this.logger.warn(`Skip unreadable code path: ${currentPath} (${error instanceof Error ? error.message : 'unknown error'})`);
        return;
      }

      if (stat.isDirectory()) {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(currentPath, { withFileTypes: true });
        } catch (error) {
          this.logger.warn(`Skip unreadable code directory: ${currentPath} (${error instanceof Error ? error.message : 'unknown error'})`);
          return;
        }

        for (const entry of entries) {
          if (CODE_EXCLUDED_DIRS.has(entry.name)) continue;
          walk(path.join(currentPath, entry.name));
          if (files.length >= maxFiles) return;
        }
        return;
      }

      const fileName = path.basename(currentPath);
      if (!stat.isFile() || CODE_EXCLUDED_FILES.has(fileName) || stat.size > maxFileBytes) return;

      const ext = path.extname(currentPath).toLowerCase();
      if (!allowedExtensions.has(ext)) return;

      files.push(currentPath);
    };

    walk(rootPath);
    return files;
  }
}
