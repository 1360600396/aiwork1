import { Injectable, Inject, forwardRef, Logger } from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/services/prisma.service';
import { StreamRunDto, RunDto, ChatDto } from './dto/ai.dto';
import { RAGService } from '../rag/services/rag.service';
import { WorkflowExecutorService } from '../workflow/services/workflow-executor.service';
import { Subject } from 'rxjs';
import axios from 'axios';

type LlmProvider = 'ark' | 'qwen';

interface LlmConfig {
  provider: LlmProvider;
  apiKey?: string;
  baseUrl: string;
  model: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private ragService: RAGService,
    @Inject(forwardRef(() => WorkflowExecutorService))
    private workflowExecutor: WorkflowExecutorService,
  ) {}

  /**
   * Non-streaming workflow run:
   * 1. Find the workflow by appId (or use explicit workflowId)
   * 2. Execute the workflow
   * 3. Return the final context
   */
  async run(userId: string, runDto: RunDto) {
    const workflowId = await this.resolveWorkflowId(userId, runDto.appId, runDto.workflowId);

    const result = await this.workflowExecutor.executeWorkflow(workflowId, {
      inputs: runDto.inputs as Record<string, any>,
      sessionId: runDto.sessionId,
    });

    // Extract output node result if present
    const outputResult = this.extractOutputFromContext(result);

    return {
      success: true,
      message: 'Workflow execution completed',
      data: {
        output: outputResult,
        context: result,
      },
    };
  }

  /**
   * Streaming workflow run via SSE:
   * Pushes real-time node execution status events to the client.
   */
  async streamRun(userId: string, streamRunDto: StreamRunDto, res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const workflowId = await this.resolveWorkflowId(userId, streamRunDto.appId, streamRunDto.workflowId);

      const sseSubject = new Subject<any>();

      sseSubject.subscribe({
        next: (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
        complete: () => {
          res.end();
        },
        error: (err) => {
          res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
          res.end();
        },
      });

      await this.workflowExecutor.executeWorkflow(workflowId, {
        inputs: streamRunDto.inputs as Record<string, any>,
        sessionId: streamRunDto.sessionId,
      }, sseSubject);

      sseSubject.complete();
    } catch (error) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Unknown error' })}\n\n`);
      res.end();
    }
  }

  /**
   * Resolve workflowId: use explicit workflowId if provided,
   * otherwise find the latest workflow for the given appId.
   */
  private async resolveWorkflowId(userId: string, appId: string, workflowId?: string): Promise<string> {
    if (workflowId) {
      return workflowId;
    }

    // Validate app ownership
    const app = await this.prisma.application.findUnique({
      where: { id: appId },
    });

    if (!app) {
      throw new Error('Application not found');
    }

    if (app.userId !== userId) {
      throw new Error('You do not have permission to run this application');
    }

    // Find the latest workflow for this app
    const workflow = await this.prisma.workflow.findFirst({
      where: { applicationId: appId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });

    if (!workflow) {
      throw new Error('No workflow found for this application. Please create a workflow first.');
    }

    return workflow.id;
  }

  /**
   * Extract the output from the execution context.
   * Looks for output node results, or returns the last node's result.
   */
  private extractOutputFromContext(context: Record<string, any>): any {
    // Try to find an output node result (key pattern: node with result property)
    for (const [, value] of Object.entries(context)) {
      if (value && typeof value === 'object' && 'result' in value) {
        // Return the last result found
        continue;
      }
    }

    // Return the whole context if no specific output found
    return context;
  }

  private getLlmConfig(model?: string): LlmConfig {
    const provider = this.configService.get<LlmProvider>('LLM_PROVIDER') || 'ark';
    const genericApiKey = this.getTrimmedConfig('LLM_API_KEY');
    const genericBaseUrl = this.getTrimmedConfig('LLM_BASE_URL');
    const genericModel = this.getTrimmedConfig('LLM_MODEL');

    if (provider === 'qwen') {
      return {
        provider,
        apiKey: genericApiKey || this.getTrimmedConfig('QWEN_API_KEY'),
        baseUrl: genericBaseUrl || this.getTrimmedConfig('QWEN_BASE_URL') || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: model?.trim() || genericModel || this.getTrimmedConfig('QWEN_MODEL') || 'qwen-turbo',
      };
    }

    return {
      provider: 'ark',
      apiKey: genericApiKey || this.getTrimmedConfig('ARK_API_KEY'),
      baseUrl: genericBaseUrl || this.getTrimmedConfig('ARK_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3',
      model: model?.trim() || genericModel || this.getTrimmedConfig('ARK_MODEL') || 'doubao-seed-1-6-250615',
    };
  }

  private getTrimmedConfig(key: string): string | undefined {
    return this.configService.get<string>(key)?.trim();
  }

  private maskSecret(value?: string): string {
    if (!value) {
      return '<empty>';
    }

    return `${value.slice(0, 4)}... len=${value.length}`;
  }

  private logLlmConfig(config: LlmConfig) {
    this.logger.warn(
      `LLM config: provider=${config.provider}, baseUrl=${config.baseUrl}, model=${config.model}, apiKey=${this.maskSecret(config.apiKey)}`,
    );
  }

  private assertLlmConfigured(config: LlmConfig) {
    if (!config.apiKey) {
      throw new Error(`${config.provider.toUpperCase()} API key is not configured`);
    }
  }

  private async readErrorStream(data: unknown): Promise<string | undefined> {
    if (!data || typeof data !== 'object' || !('on' in data)) {
      return undefined;
    }

    const stream = data as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];

    return new Promise((resolve) => {
      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', () => resolve(undefined));
    });
  }

  private formatLlmError(code?: string, message?: string, status?: number): string {
    if (code === 'AuthenticationError' && message?.includes('API key format is incorrect')) {
      return '火山方舟 API Key 格式不正确。请使用方舟控制台「API Key 管理」里生成的调用密钥，并更新 .env 中的 LLM_API_KEY/ARK_API_KEY/EMBEDDING_API_KEY。';
    }

    if (code === 'ModelNotOpen') {
      return '火山方舟模型未开通或模型名/推理接入点 ID 不正确。请在 .env 中把 LLM_MODEL/ARK_MODEL 改成方舟控制台里已开通的模型或 ep- 开头的推理接入点 ID。';
    }

    const details = [code, message].filter(Boolean).join(': ');
    if (details) {
      return details;
    }

    return status ? `LLM API 请求失败，HTTP ${status}` : 'LLM API 请求失败';
  }

  private async getLlmErrorMessage(error: unknown): Promise<string> {
    if (!axios.isAxiosError(error)) {
      return error instanceof Error ? error.message : 'Unknown error';
    }

    const status = error.response?.status;
    const responseData = error.response?.data;
    const rawBody =
      typeof responseData === 'string'
        ? responseData
        : await this.readErrorStream(responseData);

    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody);
        return this.formatLlmError(parsed?.error?.code, parsed?.error?.message, status);
      } catch {
        return rawBody;
      }
    }

    if (responseData && typeof responseData === 'object' && 'error' in responseData) {
      const errorData = responseData as { error?: { code?: string; message?: string } };
      return this.formatLlmError(errorData.error?.code, errorData.error?.message, status);
    }

    return this.formatLlmError(undefined, error.message, status);
  }

  private hasCodeReference(references: any[]): boolean {
    return references.some((ref: any) => ref.metadata?.type === 'code' || ref.metadata?.path);
  }

  async chat(userId: string, chatDto: ChatDto, res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let activeLlmConfig: LlmConfig | undefined;

    try {
      const startedAt = Date.now();
      const { message, history = [], sessionId = Date.now().toString(), knowledgeBaseId } = chatDto;
      const llmConfig = this.getLlmConfig();
      activeLlmConfig = llmConfig;
      this.assertLlmConfigured(llmConfig);

      // 1. 保存用户消息（非阻塞，失败不影响对话）
      this.prisma.chatHistory.create({
        data: { sessionId, role: 'user', content: message, userId },
      }).catch((e) => console.error('保存用户消息失败:', e.message));

      let context = '';
      let references: any[] = [];
      let hasCodeReferences = false;
      const historyLimit = Number(this.configService.get<string>('CHAT_HISTORY_LIMIT') || 6);
      const ragTopK = Number(this.configService.get<string>('RAG_TOP_K') || 3);
      const maxContextChars = Number(this.configService.get<string>('RAG_MAX_CONTEXT_CHARS') || 5000);
      const codeMaxContextChars = Number(this.configService.get<string>('CODE_RAG_MAX_CONTEXT_CHARS') || 9000);

      // 2. RAG 检索（失败时降级为无知识库模式）
      if (knowledgeBaseId) {
        try {
          const ragStartedAt = Date.now();
          references = await this.ragService.retrieve(message, knowledgeBaseId, ragTopK);
          hasCodeReferences = this.hasCodeReference(references);
          context = references
            .map((ref: any) => ref.content)
            .join('\n\n')
            .slice(0, hasCodeReferences ? codeMaxContextChars : maxContextChars);
          this.logger.log(
            `RAG context ready in ${Date.now() - ragStartedAt}ms: references=${references.length}, chars=${context.length}`,
          );
        } catch (ragError) {
          console.error('RAG 检索失败，降级为普通对话:', ragError.message);
        }
      }

      // 3. 构建消息
      const messages = [];
      if (context) {
        messages.push({
          role: 'system',
          content: `你是一个基于知识库回答问题的助手。请参考以下内容回答：\n\n${context}`,
        });
      }
      messages.push(...history.slice(-historyLimit));
      messages.push({ role: 'user', content: message });

      // 4. 调用 OpenAI-compatible 流式 API
      const llmStartedAt = Date.now();
      const response = await axios.post(
        `${llmConfig.baseUrl}/chat/completions`,
        { model: llmConfig.model, messages, stream: true },
        {
          headers: {
            Authorization: `Bearer ${llmConfig.apiKey}`,
            'Content-Type': 'application/json',
          },
          responseType: 'stream',
          timeout: 30000,
        },
      );
      this.logger.log(
        `LLM stream connected in ${Date.now() - llmStartedAt}ms, totalBeforeStream=${Date.now() - startedAt}ms, messages=${messages.length}`,
      );

      let fullAssistantContent = '';
      let firstTokenLogged = false;

      response.data.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter((line) => line.trim() !== '');
        for (const line of lines) {
          if (line.includes('[DONE]')) continue;
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              const content = data.choices[0]?.delta?.content || '';
              if (content) {
                if (!firstTokenLogged) {
                  firstTokenLogged = true;
                  this.logger.log(`LLM first token in ${Date.now() - llmStartedAt}ms, total=${Date.now() - startedAt}ms`);
                }
                fullAssistantContent += content;
                res.write(`data: ${JSON.stringify({ type: 'text', content })}\n\n`);
              }
            } catch {
              // 忽略解析错误
            }
          }
        }
      });

      response.data.on('end', async () => {
        // 保存助手回复（非阻塞）
        this.prisma.chatHistory.create({
          data: {
            sessionId,
            role: 'assistant',
            content: fullAssistantContent,
            userId,
            references: JSON.stringify(references),
          },
        }).catch((e) => console.error('保存助手消息失败:', e.message));

        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      });

      response.data.on('error', (err: Error) => {
        console.error('LLM 流式响应错误:', err.message);
        const safeMsg = (err.message || '流式响应异常').replace(/[\n\r]/g, ' ');
        res.write(`data: ${JSON.stringify({ type: 'error', message: safeMsg })}\n\n`);
        res.end();
      });

    } catch (error) {
      if (activeLlmConfig) {
        this.logLlmConfig(activeLlmConfig);
      }
      const errorMessage = await this.getLlmErrorMessage(error);
      console.error('Chat error:', errorMessage);
      const safeMsg = errorMessage.replace(/[\n\r]/g, ' ');
      res.write(`data: ${JSON.stringify({ type: 'error', message: safeMsg })}\n\n`);
      res.end();
    }
  }

  async chatWithLLM(
    userPrompt: string,
    systemPrompt?: string,
    history: any[] = [],
    model?: string,
    temperature = 0.7,
    maxTokens = 2048,
  ): Promise<string> {
    const llmConfig = this.getLlmConfig(model);
    this.assertLlmConfigured(llmConfig);

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push(...history);
    messages.push({ role: 'user', content: userPrompt });

    try {
      const response = await axios.post(
        `${llmConfig.baseUrl}/chat/completions`,
        {
          model: llmConfig.model,
          messages,
          temperature,
          max_tokens: maxTokens,
        },
        {
          headers: {
            Authorization: `Bearer ${llmConfig.apiKey}`,
            'Content-Type': 'application/json',
          },
        },
      );
      return response.data.choices[0].message.content;
    } catch (error) {
      this.logLlmConfig(llmConfig);
      const errorMessage = await this.getLlmErrorMessage(error);
      console.error('Error calling LLM API:', errorMessage);
      throw new Error(errorMessage);
    }
  }

  async getChatHistory(userId: string, sessionId: string) {
    return this.prisma.chatHistory.findMany({
      where: {
        sessionId,
        userId,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        role: true,
        content: true,
        references: true,
        toolCalls: true,
        createdAt: true,
      },
    });
  }

  async getAllChatHistories(userId: string, appId?: string) {
    const where: { userId: string; metadata?: { path: string[]; equals: string } } = { userId };
    
    if (appId) {
      where.metadata = { path: ['appId'], equals: appId };
    }

    const histories = await this.prisma.chatHistory.groupBy({
      by: ['sessionId'],
      where,
      _max: {
        createdAt: true,
      },
    });

    return histories.map((h: any) => ({
      sessionId: h.sessionId,
      lastMessageAt: h._max.createdAt,
    }));
  }
}
