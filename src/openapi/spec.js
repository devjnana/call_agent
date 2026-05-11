/**
 * OpenAPI 3.0 specification for the translation engine HTTP surface.
 * WebSocket media: `GET` upgrade on `/ws/plivo` — use Plivo Stream API, not this UI.
 */
import { env } from '../config/env.js';

const base = {
  openapi: '3.0.3',
  info: {
    title: 'Realtime Voice Translation Engine',
    version: '1.0.0',
    description: [
      'Stateless CRM integration API: originates Plivo calls, bridges a muted conference,',
      'and streams µ-law audio through OpenAI Realtime Translation.',
      '',
      '**WebSocket (not REST):** Plivo opens `wss://{WS_BASE_URL}/ws/plivo?session={uuid}&leg=agent|customer` after `POST .../Call/{uuid}/Stream/`.',
      'Swagger UI cannot exercise that leg — use live Plivo traffic or a WebSocket client.',
    ].join('\n'),
  },
  tags: [
    { name: 'CRM', description: 'Start outbound interpreted calls from your CRM' },
    { name: 'Health', description: 'Kubernetes-style probes' },
    { name: 'Plivo', description: 'Server-to-server callbacks (signing optional via PLIVO_VALIDATE_SIGNATURES)' },
  ],
  paths: {
    '/call': {
      post: {
        tags: ['CRM'],
        summary: 'Start translation bridge',
        description:
          'Dials the agent (telecaller) first, then the customer, joins both in a muted conference, and attaches bidirectional audio streams.',
        operationId: 'startCall',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/StartCallRequest' },
              examples: {
                enHi: {
                  summary: 'English agent, Hindi customer',
                  value: {
                    agent_number: '+919999999999',
                    customer_number: '+918888888888',
                    agent_language: 'english',
                    customer_language: 'hindi',
                  },
                },
              },
            },
          },
        },
        responses: {
          '202': {
            description: 'Call flow accepted; dialing agent',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/StartCallAccepted' },
              },
            },
          },
          '400': {
            description: 'Validation / CRM payload error',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          '500': {
            description: 'Unexpected server error',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/health/live': {
      get: {
        tags: ['Health'],
        summary: 'Liveness',
        operationId: 'healthLive',
        responses: {
          '200': {
            description: 'Process is running',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthLive' },
              },
            },
          },
        },
      },
    },
    '/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness',
        operationId: 'healthReady',
        responses: {
          '200': {
            description: 'Ready to accept traffic',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthReady' },
              },
            },
          },
        },
      },
    },
    '/plivo/webhook/answer': {
      post: {
        tags: ['Plivo'],
        summary: 'Answer URL — join conference + start media stream',
        description:
          'Invoked by Plivo when a callee answers. Returns XML with `<Conference>`. Requires Plivo signing headers if `PLIVO_VALIDATE_SIGNATURES=true`.',
        operationId: 'plivoAnswer',
        parameters: [
          {
            name: 'session',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'uuid' },
            description: 'Translation session id from outbound originate URL',
          },
          {
            name: 'leg',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['agent', 'customer'] },
          },
        ],
        requestBody: {
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: {
                  CallUUID: { type: 'string', description: 'Active call leg id' },
                  From: { type: 'string' },
                  To: { type: 'string' },
                  Direction: { type: 'string' },
                  CallStatus: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'XML `<Response><Conference …/></Response>`',
            content: {
              'text/xml': {
                schema: { type: 'string', example: '<?xml version="1.0" encoding="UTF-8"?>…' },
              },
            },
          },
          '403': { description: 'Invalid Plivo signature (when validation enabled)' },
        },
      },
    },
    '/plivo/webhook/hangup': {
      post: {
        tags: ['Plivo'],
        summary: 'Hangup callback',
        description: 'Tears down the in-memory session when a leg ends.',
        operationId: 'plivoHangup',
        parameters: [
          {
            name: 'session',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: {
                  CallUUID: { type: 'string' },
                  HangupCause: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'OK' },
          '403': { description: 'Invalid Plivo signature' },
        },
      },
    },
  },
  components: {
    schemas: {
      StartCallRequest: {
        type: 'object',
        required: ['agent_number', 'customer_number', 'agent_language', 'customer_language'],
        properties: {
          agent_number: {
            type: 'string',
            description: 'Telecaller E.164',
            example: '+919999999999',
            pattern: '^\\+[1-9]\\d{6,14}$',
          },
          customer_number: {
            type: 'string',
            description: 'Customer E.164',
            example: '+918888888888',
            pattern: '^\\+[1-9]\\d{6,14}$',
          },
          agent_language: {
            type: 'string',
            description:
              'Target language the **agent should hear** (interpreter output toward agent). Use `english`, `hindi`, ISO 639-1, or `auto` (pair with explicit other side).',
            example: 'english',
          },
          customer_language: {
            type: 'string',
            description: 'Target language the **customer should hear**.',
            example: 'hindi',
          },
        },
      },
      StartCallAccepted: {
        type: 'object',
        properties: {
          session_id: { type: 'string', format: 'uuid' },
          conference: {
            type: 'string',
            description: 'Plivo conference room name',
            example: 'tr-a1b2c3d4-...',
          },
          state: { type: 'string', example: 'dialing_agent' },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string' },
        },
      },
      HealthLive: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          active_sessions: { type: 'integer' },
          uptime_s: { type: 'integer' },
          ts: { type: 'string', format: 'date-time' },
        },
      },
      HealthReady: {
        type: 'object',
        properties: {
          ready: { type: 'boolean' },
        },
      },
    },
  },
};

/**
 * Servers list: prefer configured `BASE_URL` for external tools; keep `/` for same-origin Try it out.
 */
export function getOpenApiSpec() {
  const publicBase =
    env.baseUrl && !/^http:\/\/127\.0\.0\.1(?::\d+)?\/?$/i.test(env.baseUrl)
      ? env.baseUrl.replace(/\/$/, '')
      : null;

  return {
    ...base,
    servers: publicBase
      ? [
          { url: '/', description: 'Same origin as this Swagger UI' },
          { url: publicBase, description: 'Public BASE_URL (ngrok / production)' },
        ]
      : [{ url: '/', description: 'Same origin — use Try it out when UI and API share host:port' }],
  };
}
