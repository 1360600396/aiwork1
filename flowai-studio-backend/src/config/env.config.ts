import { z } from 'zod';

export const envSchema = z.object({
  // 服务器配置
  PORT: z.string().default('3001'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),

  // JWT配置
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // LLM API配置（支持 OpenAI-compatible provider，如火山引擎方舟、通义千问）
  LLM_PROVIDER: z.enum(['ark', 'qwen']).default('ark'),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),
  LLM_MODEL: z.string().optional(),

  // 火山引擎方舟API配置
  ARK_API_KEY: z.string().optional(),
  ARK_BASE_URL: z.string().default('https://ark.cn-beijing.volces.com/api/v3'),
  ARK_MODEL: z.string().default('doubao-seed-1-6-250615'),
  ARK_EMBEDDING_MODEL: z.string().default('doubao-embedding-text-240715'),

  // RAG 向量化配置（支持 OpenAI-compatible embeddings）
  EMBEDDING_PROVIDER: z.enum(['ark', 'qwen']).default('ark'),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  RAG_TOP_K: z.string().default('2'),
  RAG_CHUNK_SIZE: z.string().default('800'),
  RAG_CHUNK_OVERLAP: z.string().default('100'),
  RAG_MAX_CONTEXT_CHARS: z.string().default('2500'),
  CODE_RAG_MAX_CONTEXT_CHARS: z.string().default('9000'),
  CHAT_HISTORY_LIMIT: z.string().default('4'),

  // 通义千问API配置
  QWEN_API_KEY: z.string().optional(),
  QWEN_BASE_URL: z.string().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  QWEN_MODEL: z.string().default('qwen-turbo'),
  QWEN_EMBEDDING_MODEL: z.string().default('text-embedding-v3'),

  // 文件上传配置
  UPLOAD_PATH: z.string().default('./uploads'),
  MAX_FILE_SIZE: z.string().default('10485760'),

  // 数据库配置
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
});

export type EnvConfig = z.infer<typeof envSchema>;
