import type { OwnerFolderPrefill } from './config.ts';

const escape = (value: string): string => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

/** Called only with Connections.list's authenticated, provider-verified tenant identity. */
export function initialFolderInputs(
  prefill: OwnerFolderPrefill | undefined,
  identity: Readonly<{ issuer: string; sub: string }>,
  hasSavedBinding: boolean,
): string {
  // A saved binding always wins. Prefill never creates or updates a binding.
  if (hasSavedBinding) return '';
  const selected = prefill?.issuer === identity.issuer && prefill.sub === identity.sub ? prefill : undefined;
  const fields = [
    ['manualFolderId','Manual commands'], ['commandsFolderId','Direct commands'],
    ['resultsFolderId','Results'], ['stateFolderId','State (optional)'],
  ] as const;
  return fields.map(([name,label]) => {
    const value = name === 'stateFolderId' ? '' : selected?.[name] ?? '';
    // Editable ordinary form values: the submitted FormData, not this setting, controls POST validation.
    return `<p><label>${label}<input name="${name}" value="${escape(value)}" ${name === 'stateFolderId' ? '' : 'required'} pattern="[A-Za-z0-9_-]{1,256}" maxlength="256"></label></p>`;
  }).join('');
}
