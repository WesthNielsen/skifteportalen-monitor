import { collectSnapshot, runMonitor, splitMessages } from "./monitor.ts";
import { createNotifier, createStore, readConfig } from "./services.ts";
import type { Notify } from "./model.ts";

let notify: Notify | undefined;
try {
  const config = readConfig();
  notify = createNotifier(config.webhookUrl);
  const result = await runMonitor(createStore(config), collectSnapshot, notify);
  console.log(`Skifteportalen monitor: ${result}`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unexpected monitor failure";
  console.error(`Skifteportalen monitor failed: ${message}`);
  if (notify) {
    try {
      await notify(splitMessages(`Skifteportalen monitor failed. The baseline was not advanced.\n${message}`));
    } catch (notificationError) {
      console.error("Could not deliver the failure alert:",
        notificationError instanceof Error ? notificationError.message : "Unknown notification error");
    }
  }
  process.exitCode = 1;
}
