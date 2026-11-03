export const MODELS = [
  {
    id: 'standard',
    label: 'Standard',
    description: 'Best answers. Recommended for most computers.',
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    repo: 'Qwen3-1.7B-GGUF',
    approxMB: 1100,
    recommended: true,
  },
  {
    id: 'light',
    label: 'Light',
    description: 'Smaller and faster. Good for older computers.',
    file: 'Qwen3-0.6B-Q4_K_M.gguf',
    repo: 'Qwen3-0.6B-GGUF',
    approxMB: 400,
    recommended: false,
  },
];

export function urlFor(repo, name) {
  return `https://huggingface.co/unsloth/${repo}/resolve/main/${name}`;
}

export async function fallbackName(repo) {
  const res = await fetch(`https://huggingface.co/api/models/unsloth/${repo}`);
  if (!res.ok) throw new Error(`Repo listing failed (${res.status}): ${repo}`);
  const info = await res.json();
  const hit = (info.siblings || []).map((s) => s.rfilename).find((n) => n.endsWith('Q4_K_M.gguf'));
  if (!hit) throw new Error(`No Q4_K_M.gguf file found in ${repo}`);
  return hit;
}

/** Download a catalog model, retrying under the repo's real file name on a 404. */
export async function fetchModel(model, destPath, downloadFn, onProgress, lookup = fallbackName) {
  const attempt = (name) => downloadFn(urlFor(model.repo, name), destPath, { onProgress });
  try {
    return await attempt(model.file);
  } catch (err) {
    if (!/Download failed \(404\)/.test(err.message)) throw err;
    return attempt(await lookup(model.repo));
  }
}
