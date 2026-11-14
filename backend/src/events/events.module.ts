import { Controller, Get, Global, Module, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Authenticated, CurrentPrincipal, NoSessionRefresh } from '../auth/auth.decorators';
import type { Principal } from '../auth/auth.types';
import { ClusterChannel } from './cluster-channel.service';
import { EventBus } from './event-bus.service';
import { StreamService } from './stream.service';

/** GET /stream: Server-Sent Events for the active role (ADR-0008). */
@Controller('stream')
export class StreamController {
  constructor(private readonly streams: StreamService) {}

  @Get()
  @Authenticated()
  @NoSessionRefresh()
  subscribe(
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
    @Res() response: Response,
  ): void {
    this.streams.open(principal, request, response);
  }
}

/** Live events: the bus every feature publishes to, its Postgres fan-out and the SSE endpoint. */
@Global()
@Module({
  controllers: [StreamController],
  providers: [ClusterChannel, EventBus, StreamService],
  exports: [ClusterChannel, EventBus],
})
export class EventsModule {}
