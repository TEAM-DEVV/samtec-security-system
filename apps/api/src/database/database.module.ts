import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/** Provides one shared `PrismaService` to the whole application. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
