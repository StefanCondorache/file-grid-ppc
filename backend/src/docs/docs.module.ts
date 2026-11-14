import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Header, Module } from '@nestjs/common';

/**
 * The OpenAPI 3 document of the real API (src/docs/openapi.json, written by hand from the frontend's
 * proposal and checked against the Nest routes and real answers by test/docs.e2e-spec.ts). The
 * frontend generates its types from it: `API_SPEC=https://<host>/api/v1/docs-json npm run gen:api`.
 */
const DOCUMENT: string = readFileSync(join(__dirname, 'openapi.json'), 'utf8');

@Controller()
export class DocsController {
  /** Public, like Swagger's docs-json: the shape of the API is not a secret, the data is. */
  @Get('docs-json')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Cache-Control', 'no-cache')
  document(): string {
    return DOCUMENT;
  }
}

@Module({ controllers: [DocsController] })
export class DocsModule {}
