import { Module } from "@nestjs/common";
import { TemplateController } from "./template.controller";
import { TemplateEngine } from "./TemplateEngine";
import { TemplateService } from "./TemplateService";


@Module({
    controllers: [TemplateController],
    providers: [TemplateEngine, TemplateService],
    exports: [TemplateEngine, TemplateService]
})
export class TemplateModule {}