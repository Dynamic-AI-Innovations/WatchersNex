import { DynamicModule, Module } from '@nestjs/common';
import type { Logger } from 'pino';
import { LOGGER } from './common/logger.js';
import { APP_CONFIG, AppConfig } from './config/config.js';
import { DatabaseModule } from './db/database.module.js';
import { EMAIL_SENDER, EmailSender, LogEmailSender } from './email/email.js';
import { PostmarkEmailSender } from './email/postmark.js';
import { HealthController } from './health/health.controller.js';
import { AuthController } from './identity/auth.controller.js';
import { AuthGuard } from './identity/auth.guard.js';
import { AuthService } from './identity/auth.service.js';
import { IncidentsService } from './monitoring/incidents.service.js';
import { MonitoringController } from './monitoring/monitoring.controller.js';
import { MonitorsService } from './monitoring/monitors.service.js';
import { MONITOR_POLICY } from './monitoring/policy.js';
import { PUBLIC_ONLY, TargetPolicy } from './monitoring/ssrf.js';
import { AlertPoliciesService } from './monitoring/alert-policies.service.js';
import { ReportsService } from './monitoring/reports.service.js';
import { MembersService } from './tenancy/members.service.js';
import { OrgsController } from './tenancy/orgs.controller.js';
import { AccountController, InvitationsController, SettingsController } from './tenancy/settings.controller.js';
import { WorkspaceService } from './tenancy/workspace.service.js';
import { OrgsService } from './tenancy/orgs.service.js';

export interface AppOverrides {
  /** Tests replace email delivery with an in-memory sender. */
  emailSender?: EmailSender;
  /** Tests allow loopback targets; production always uses PUBLIC_ONLY. */
  monitorPolicy?: TargetPolicy;
}

function emailSenderFor(config: AppConfig, logger: Logger): EmailSender {
  if (config.EMAIL_TRANSPORT === 'postmark') {
    return new PostmarkEmailSender(config.POSTMARK_SERVER_TOKEN as string, config.EMAIL_FROM);
  }
  return new LogEmailSender(logger, config.EMAIL_LOG_LINKS);
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, logger: Logger, overrides: AppOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DatabaseModule],
      controllers: [HealthController, AuthController, AccountController, OrgsController, SettingsController, InvitationsController, MonitoringController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
        { provide: EMAIL_SENDER, useValue: overrides.emailSender ?? emailSenderFor(config, logger) },
        AuthService,
        AuthGuard,
        OrgsService,
        MonitorsService,
        IncidentsService,
        MembersService,
        WorkspaceService,
        AlertPoliciesService,
        ReportsService,
        { provide: MONITOR_POLICY, useValue: overrides.monitorPolicy ?? PUBLIC_ONLY },
      ],
      exports: [APP_CONFIG, LOGGER, EMAIL_SENDER],
    };
  }
}
