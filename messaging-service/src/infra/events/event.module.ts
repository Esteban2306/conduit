import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EventBusService } from './event.service';

@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 50,
      verboseMemoryLeak: true,
    }),
  ],
  providers: [EventBusService],
  exports: [EventBusService],
})
export class EventModule {}
