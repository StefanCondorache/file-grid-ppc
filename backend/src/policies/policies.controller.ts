import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, CurrentPrincipal } from '../auth/auth.decorators';
import type { Principal } from '../auth/auth.types';
import { CATEGORIES, type Category } from '../common/domain';
import { ZodPipe } from '../common/zod.pipe';
import { PoliciesService, type PolicyUpdate, policyUpdateSchema } from './policies.service';
import type { PolicyView } from './policy.types';

const categoryParam = new ZodPipe(z.enum(CATEGORIES));

@Controller('policies')
export class PoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  @Get()
  @Authenticated()
  async list(): Promise<{ data: PolicyView[] }> {
    return { data: await this.policies.list() };
  }

  @Get(':category')
  @Authenticated()
  get(@Param('category', categoryParam) category: Category): Promise<PolicyView> {
    return this.policies.getView(category);
  }

  @Put(':category')
  @Authenticated('edit_policies')
  update(
    @Param('category', categoryParam) category: Category,
    @Body(new ZodPipe(policyUpdateSchema)) body: PolicyUpdate,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PolicyView> {
    return this.policies.update(category, body, principal);
  }

  @Get(':category/versions')
  @Authenticated()
  async versions(@Param('category', categoryParam) category: Category) {
    return { data: await this.policies.versions(category) };
  }
}
