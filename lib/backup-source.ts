import hostingConfig from "../.openai/hosting.json" with { type: "json" };

export type BackupSource = {
  projectId: string;
  binding: string;
};

export function d1BackupSource(): BackupSource {
  return sourceForBinding(hostingConfig.d1, "D1");
}

export function r2BackupSource(): BackupSource {
  return sourceForBinding(hostingConfig.r2, "R2");
}

function sourceForBinding(binding: unknown, resource: string): BackupSource {
  const projectId = hostingConfig.project_id;
  if (
    typeof projectId !== "string" ||
    !projectId.trim() ||
    typeof binding !== "string" ||
    !binding.trim()
  ) {
    throw new Error(`${resource} backup source is unavailable.`);
  }
  return { projectId: projectId.trim(), binding: binding.trim() };
}
