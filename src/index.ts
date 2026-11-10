#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { generateImageTool } from './tools/image.js';
import { tosPutObjectTool } from './tools/tos.js';
import { asrTranscribeTool } from './tools/auc.js';
import { ttsUnidirectionalTool } from './tools/tts.js';
import { webSearchTool } from './tools/search.js';

async function main() {
  const server = new McpServer(
    { name: 'volcengine-api-mcp', version: '0.1.0' },
    { instructions: '通过此服务调用火山引擎 API（方舟生图 / TOS / 语音识别等）。' },
  );

  server.registerTool(generateImageTool.name, {
    title: '火山方舟图片生成 plan/images/generations',
    description: generateImageTool.description,
    inputSchema: generateImageTool.inputSchema,
  }, generateImageTool.handler);

  server.registerTool(tosPutObjectTool.name, {
    title: 'TOS 上传文件 tos/object/put',
    description: tosPutObjectTool.description,
    inputSchema: tosPutObjectTool.inputSchema,
  }, tosPutObjectTool.handler);

  server.registerTool(asrTranscribeTool.name, {
    title: '大模型录音文件识别 auc/bigmodel',
    description: asrTranscribeTool.description,
    inputSchema: asrTranscribeTool.inputSchema,
  }, asrTranscribeTool.handler);

  server.registerTool(ttsUnidirectionalTool.name, {
    title: '语音合成（单向流式）plan/tts/unidirectional',
    description: ttsUnidirectionalTool.description,
    inputSchema: ttsUnidirectionalTool.inputSchema,
  }, ttsUnidirectionalTool.handler);

  server.registerTool(webSearchTool.name, {
    title: '联网搜索 askecho/WebSearch',
    description: webSearchTool.description,
    inputSchema: webSearchTool.inputSchema,
  }, webSearchTool.handler);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[volcengine-api-mcp] server started on stdio');
}

main().catch((err) => {
  console.error('[volcengine-api-mcp] fatal:', err);
  process.exit(1);
});
