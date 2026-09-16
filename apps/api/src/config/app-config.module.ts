import { Global, Module } from '@nestjs/common';
import { AppConfig } from './app-config.js';

/**
 * Makes `AppConfig` available to every module. `@Global()` means other modules
 * can inject it without importing this module themselves.
 */
@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => AppConfig.fromProcessEnv() }],
  exports: [AppConfig],
})
export class AppConfigModule {}
