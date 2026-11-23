const SECRET_NAME = /TOKEN|SECRET|PASSW|KEY|CREDENTIAL|AUTH/i;

/**
 * Masks the values of secret-named variables, raw or JSON-escaped: plugin configs interpolate
 * `${VAR}`, so error text may echo one. Short values stay: masking them would garble the text.
 */
export function maskSecretValues(text: string, env: Record<string, string | undefined>): string {
  let masked = text;
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SECRET_NAME.test(name)) continue;
    for (const form of new Set([JSON.stringify(value).slice(1, -1), value])) {
      masked = masked.split(form).join("***");
    }
  }
  return masked;
}
