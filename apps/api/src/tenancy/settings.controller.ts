import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimiter } from '../common/rate-limit.js';
import { parseBody } from '../common/validation.js';
import { AuthGuard, CurrentSession, requestMeta } from '../identity/auth.guard.js';
import { AuthService, changePasswordSchema, profileSchema, ResolvedSession } from '../identity/auth.service.js';
import { AlertPoliciesService, alertPolicySchema } from '../monitoring/alert-policies.service.js';
import { reportQuerySchema, ReportsService } from '../monitoring/reports.service.js';
import { acceptSchema, changeRoleSchema, inviteSchema, MembersService } from './members.service.js';
import { OrgsService } from './orgs.service.js';
import { auditQuerySchema, updateOrgSchema, WorkspaceService } from './workspace.service.js';
import { APP_CONFIG, AppConfig } from '../config/config.js';

const ADMINS = ['owner', 'admin'] as const;

/** Organisation settings, members, alert rules, plan, audit log and reports. */
@Controller('orgs/:orgId')
@UseGuards(AuthGuard)
export class SettingsController {
  constructor(
    private readonly orgs: OrgsService,
    private readonly members: MembersService,
    private readonly workspace: WorkspaceService,
    private readonly policies: AlertPoliciesService,
    private readonly reports: ReportsService,
  ) {}

  @Patch()
  async updateOrg(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Body() body: unknown, @Req() req: Request) {
    await this.orgs.requireRole(s.user.id, orgId, ['owner']);
    const org = await this.workspace.update(orgId, s.user.id, parseBody(updateOrgSchema, body), requestMeta(req));
    return { ...org, role: 'owner' };
  }

  @Get('members')
  async listMembers(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string) {
    await this.orgs.requireMembership(s.user.id, orgId);
    return this.members.list(orgId);
  }

  @Post('invitations')
  @HttpCode(201)
  async invite(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Body() body: unknown, @Req() req: Request) {
    await this.orgs.requireRole(s.user.id, orgId, [...ADMINS]);
    return this.members.invite(orgId, s.user, parseBody(inviteSchema, body), requestMeta(req));
  }

  @Delete('invitations/:invitationId')
  @HttpCode(204)
  async revokeInvite(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Param('invitationId') id: string, @Req() req: Request): Promise<void> {
    await this.orgs.requireRole(s.user.id, orgId, [...ADMINS]);
    await this.members.revokeInvitation(orgId, s.user.id, id, requestMeta(req));
  }

  @Patch('members/:userId')
  async changeRole(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Param('userId') userId: string, @Body() body: unknown, @Req() req: Request) {
    const me = await this.orgs.requireRole(s.user.id, orgId, [...ADMINS]);
    return this.members.changeRole(orgId, { id: s.user.id, role: me.role }, userId, parseBody(changeRoleSchema, body).role, requestMeta(req));
  }

  @Delete('members/:userId')
  @HttpCode(204)
  async removeMember(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Param('userId') userId: string, @Req() req: Request): Promise<void> {
    const me = await this.orgs.requireMembership(s.user.id, orgId);
    await this.members.remove(orgId, { id: s.user.id, role: me.role }, userId, requestMeta(req));
  }

  @Get('alert-policies')
  async listPolicies(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string) {
    await this.orgs.requireMembership(s.user.id, orgId);
    return { items: await this.policies.list(orgId) };
  }

  @Post('alert-policies')
  @HttpCode(201)
  async createPolicy(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Body() body: unknown, @Req() req: Request) {
    await this.orgs.requireRole(s.user.id, orgId, [...ADMINS]);
    return this.policies.create(orgId, s.user.id, parseBody(alertPolicySchema, body), requestMeta(req));
  }

  @Put('alert-policies/:policyId')
  async updatePolicy(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Param('policyId') id: string, @Body() body: unknown, @Req() req: Request) {
    await this.orgs.requireRole(s.user.id, orgId, [...ADMINS]);
    return this.policies.update(orgId, s.user.id, id, parseBody(alertPolicySchema, body), requestMeta(req));
  }

  @Delete('alert-policies/:policyId')
  @HttpCode(204)
  async deletePolicy(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Param('policyId') id: string, @Req() req: Request): Promise<void> {
    await this.orgs.requireRole(s.user.id, orgId, [...ADMINS]);
    await this.policies.remove(orgId, s.user.id, id, requestMeta(req));
  }

  @Get('plan')
  async plan(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string) {
    await this.orgs.requireMembership(s.user.id, orgId);
    return this.workspace.planAndUsage(orgId);
  }

  @Get('audit-events')
  async audit(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Query() query: unknown) {
    await this.orgs.requireRole(s.user.id, orgId, [...ADMINS]);
    return this.workspace.auditLog(orgId, parseBody(auditQuerySchema, query));
  }

  @Get('reports/availability')
  async availability(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Query() query: unknown) {
    await this.orgs.requireMembership(s.user.id, orgId);
    const q = parseBody(reportQuerySchema, query);
    return this.reports.availability(orgId, q.from, q.to);
  }

  @Get('reports/availability.csv')
  async availabilityCsv(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Query() query: unknown, @Res() res: Response) {
    await this.orgs.requireMembership(s.user.id, orgId);
    const q = parseBody(reportQuerySchema, query);
    const csv = await this.reports.availabilityCsv(orgId, q.from, q.to);
    const name = `watchersnex-availability-${q.from.toISOString().slice(0, 10)}-to-${q.to.toISOString().slice(0, 10)}.csv`;
    res.status(200).type('text/csv; charset=utf-8').setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send('﻿' + csv); // BOM so Excel reads UTF-8 names correctly
  }
}

/** Invitation preview (public) and acceptance (signed in). */
@Controller('invitations')
export class InvitationsController {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly members: MembersService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.limiter = new RateLimiter(config.AUTH_RATE_LIMIT_PER_MINUTE);
  }

  @Get('preview')
  async preview(@Query('token') token: string | undefined, @Req() req: Request) {
    this.limiter.consume(req.ip ?? 'unknown');
    return this.members.preview(parseBody(acceptSchema, { token }).token);
  }

  @Post('accept')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async accept(@CurrentSession() s: ResolvedSession, @Body() body: unknown, @Req() req: Request) {
    this.limiter.consume(req.ip ?? 'unknown');
    return this.members.accept(s.user, parseBody(acceptSchema, body).token);
  }
}

/** The signed-in user's own profile and password. */
@Controller('me')
@UseGuards(AuthGuard)
export class AccountController {
  constructor(private readonly auth: AuthService) {}

  @Patch()
  async updateProfile(@CurrentSession() s: ResolvedSession, @Body() body: unknown, @Req() req: Request) {
    return { user: await this.auth.updateProfile(s, parseBody(profileSchema, body), requestMeta(req)) };
  }

  @Post('password')
  @HttpCode(204)
  /** The current session stays valid; every other session of this user ends. */
  async changePassword(@CurrentSession() s: ResolvedSession, @Body() body: unknown, @Req() req: Request): Promise<void> {
    await this.auth.changePassword(s, parseBody(changePasswordSchema, body), requestMeta(req));
  }
}
