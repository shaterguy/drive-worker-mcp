import * as z from 'zod/v4';
const symbol = z.string().regex(/^[0-9]{6}$/);
const signal = { issued_at: z.number().int().positive(), account_ref: z.string().regex(/^[a-f0-9]{64}$/) };
const order = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('buy'), symbol, quantity: z.number().int().positive().max(9999999999), limit_krw: z.number().int().positive().max(999999999) }),
  z.strictObject({ action: z.literal('sell'), symbol, quantity: z.number().int().positive().max(9999999999), limit_krw: z.number().int().positive().max(999999999) }),
  z.strictObject({ action: z.literal('cancel'), symbol, broker_order_no: z.string().regex(/^[0-9]{1,10}$/) })
]);
export const kbManualSchema = z.strictObject({
  job_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]*MANUAL[A-Za-z0-9._:-]*$/),
  target_server: z.enum(['Galaxy-Tab-S11-Ultra', 'Galaxy-S25']).default('Galaxy-Tab-S11-Ultra'),
  request: z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('signal-snapshot'), ...signal, candidate_symbols: z.array(symbol).max(5).optional() }),
    z.strictObject({ operation: z.literal('snapshot') }),
    z.strictObject({ operation: z.literal('read'), tr: z.string().regex(/^[A-Z][A-Z0-9]{3,15}$/), fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), offset: z.number().int().nonnegative().optional() }),
    z.strictObject({ operation: z.literal('execute'), ...signal, orders: z.array(order).min(1), execution_context: z.record(z.string(), z.json()).optional() }),
    z.strictObject({ operation: z.literal('record-hold'), ...signal }),
    z.strictObject({ operation: z.literal('broker-day'), day: z.string().regex(/^[0-9]{8}$/) }),
    z.strictObject({ operation: z.literal('order'), order_id: z.string().regex(/^[a-f0-9]{24}$/) }),
    z.strictObject({ operation: z.literal('publication-test') })
  ])
});
export function buildKbManualCommand(input: unknown) {
  const args = kbManualSchema.parse(input);
  const { operation, ...fields } = args.request;
  let command = 'python3 -B /data/data/com.termux/files/home/.local/share/kbsec-bridge/kbsec_ai.py ' + operation;
  let payload: unknown = fields;
  if (args.request.operation === 'read') {
    command += ' ' + args.request.tr + ' --offset ' + (args.request.offset ?? 0);
    payload = args.request.fields;
  }
  if (args.request.operation === 'broker-day') command += ' ' + args.request.day;
  if (args.request.operation === 'order') command += ' ' + args.request.order_id;
  if (operation === 'publication-test') {
    command = "python3 -c 'print(\"KB_MANUAL_PUBLICATION_TEST_ONLY\")'";
    payload = {};
  }
  if (args.request.operation === 'execute' && args.request.orders.some(o => o.action === 'buy') && !args.request.execution_context) {
    throw new Error('Buy drafts require the existing execution_context.');
  }
  return {
    job_id: args.job_id, command, cwd: '/data/data/com.termux/files/home',
    timeout_ms: 120000, target_server: args.target_server,
    env: { KBSEC_DRIVEWORKER_TARGET: args.target_server }, stdin: JSON.stringify(payload)
  };
}
