import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { parseBody } from '../common/validation.js';
import { AuthGuard, CurrentSession, requestMeta } from '../identity/auth.guard.js';
import type { ResolvedSession } from '../identity/auth.service.js';
import { OrgsService } from '../tenancy/orgs.service.js';
import { IncidentsService, listIncidentsSchema, noteSchema } from './incidents.service.js';
import { createMonitorSchema, MonitorsService, updateMonitorSchema } from './monitors.service.js';

const MANAGE = ['owner', 'admin'] as const;
const RESPOND = ['owner', 'admin', 'operator'] as const;

@Controller('orgs/:orgId')
@UseGuards(AuthGuard)
export class MonitoringController {
  constructor(
    private readonly orgs: OrgsService,
    private readonly monitors: MonitorsService,
    private readonly incidents: IncidentsService,
  ) {}

  @Get('overview')
  async overview(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string) {
    await this.orgs.requireMembership(s.user.id, orgId);
    return this.monitors.overview(orgId);
  }

  @Get('monitors')
  async listMonitors(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string) {
    await this.orgs.requireMembership(s.user.id, orgId);
    return { items: await this.monitors.list(orgId) };
  }

  @Post('monitors')
  @HttpCode(201)
  async createMonitor(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Body() body: unknown, @Req() req: Request) {
    await this.orgs.requireRole(s.user.id, orgId, [...MANAGE]);
    return this.monitors.create(orgId, s.user.id, parseBody(createMonitorSchema, body), requestMeta(req));
  }

  @Get('monitors/:monitorId')
  async getMonitor(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Param('monitorId') monitorId: string) {
    await this.orgs.requireMembership(s.user.id, orgId);
    return this.monitors.get(orgId, monitorId);
  }

  @Patch('monitors/:monitorId')
  async updateMonitor(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Param('monitorId') monitorId: string, @Body() body: unknown, @Req() req: Request) {
    await this.orgs.requireRole(s.user.id, orgId, [...MANAGE]);
    return this.monitors.update(orgId, s.user.id, monitorId, parseBody(updateMonitorSchema, body), requestMeta(req));
  }

  @Post('monitors/:monitorId/pause')
  async pause(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Param('monitorId') monitorId: string, @Req() req: Request) {
    await this.orgs.requireRole(s.user.id, orgId, [...MANAGE]);
    return this.monitors.setEnabled(orgId, s.user.id, monitorId, false, requestMeta(req));
  }

  @Post('monitors/:monitorId/resume')
  async resume(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Param('monitorId') monitorId: string, @Req() req: Request) {
    await this.orgs.requireRole(s.user.id, orgId, [...MANAGE]);
    return this.monitors.setEnabled(orgId, s.user.id, monitorId, true, requestMeta(req));
  }

  @Delete('monitors/:monitorId')
  @HttpCode(204)
  async deleteMonitor(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Param('monitorId') monitorId: string, @Req() req: Request): Promise<void> {
    await this.orgs.requireRole(s.user.id, orgId, [...MANAGE]);
    await this.monitors.remove(orgId, s.user.id, monitorId, requestMeta(req));
  }

  @Get('incidents')
  async listIncidents(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Query() query: unknown) {
    await this.orgs.requireMembership(s.user.id, orgId);
    return { items: await this.incidents.list(orgId, parseBody(listIncidentsSchema, query).status) };
  }

  @Get('incidents/:incidentId')
  async getIncident(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Param('incidentId') incidentId: string) {
    await this.orgs.requireMembership(s.user.id, orgId);
    return this.incidents.get(orgId, incidentId);
  }

  @Post('incidents/:incidentId/acknowledge')
  async acknowledge(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Param('incidentId') incidentId: string, @Req() req: Request) {
    await this.orgs.requireRole(s.user.id, orgId, [...RESPOND]);
    return this.incidents.acknowledge(orgId, s.user.id, incidentId, requestMeta(req));
  }

  @Post('incidents/:incidentId/resolve')
  async resolve(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Param('incidentId') incidentId: string, @Req() req: Request) {
    await this.orgs.requireRole(s.user.id, orgId, [...RESPOND]);
    return this.incidents.resolve(orgId, s.user.id, incidentId, requestMeta(req));
  }

  @Post('incidents/:incidentId/notes')
  async note(@CurrentSession() s: ResolvedSession, @Param('orgId') orgId: string, @Param('incidentId') incidentId: string, @Body() body: unknown, @Req() req: Request) {
    await this.orgs.requireRole(s.user.id, orgId, [...RESPOND]);
    return this.incidents.addNote(orgId, s.user.id, incidentId, parseBody(noteSchema, body).text, requestMeta(req));
  }
}
