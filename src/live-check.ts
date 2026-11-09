import { collectSnapshot } from "./monitor.ts";

try {
  const snapshot = await collectSnapshot();
  console.log(`Read ${snapshot.pageText.split("\n").length} article lines.`);
  console.log(`Checked ${snapshot.resources.length} linked documents.`);
  for (const resource of snapshot.resources) {
    console.log(`HTTP ${resource.status}: ${resource.label} <${resource.url}>`);
  }
  console.log("Read-only check complete. No state was written and no Discord messages were sent.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Live check failed");
  process.exitCode = 1;
}
