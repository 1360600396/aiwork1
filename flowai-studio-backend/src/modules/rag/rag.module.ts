import { Module } from '@nestjs/common';
import { RAGController } from './rag.controller';
import { RAGService } from './services/rag.service';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

@Module({
  imports: [
    MulterModule.register({
      storage: memoryStorage(),
      limits: {
        fileSize: Number(process.env.RAG_UPLOAD_MAX_MB || 50) * 1024 * 1024,
      },
    }),
  ],
  controllers: [RAGController],
  providers: [RAGService],
  exports: [RAGService],
})
export class RAGModule {}
