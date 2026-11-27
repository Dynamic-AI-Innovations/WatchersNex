import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { parseBody } from '../common/validation.js';
import { AuthGuard, CurrentSession, requestMeta } from '../identity/auth.guard.js';
import type { ResolvedSession } from '../identity/auth.service.js';
import { createOrgSchema, OrgsService } from './orgs.service.js';

@Controller('orgs')
@UseGuards(AuthGuard)
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  @Get()
  async list(@CurrentSession() session: ResolvedSession) {
    return { items: await this.orgs.listForUser(session.user.id) };
  }

  @Post()
  @HttpCode(201)
  async create(@CurrentSession() session: ResolvedSession, @Body() body: unknown, @Req() req: Request) {
    return this.orgs.create(session.user.id, parseBody(createOrgSchema, body), requestMeta(req));
  }

  @Get(':orgId')
  async get(@CurrentSession() session: ResolvedSession, @Param('orgId') orgId: string) {
    return this.orgs.get(session.user.id, orgId);
  }
}
