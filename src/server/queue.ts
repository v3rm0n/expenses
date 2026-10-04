import { PgBoss } from "pg-boss";
import { config } from "./config";
const globalQueue = globalThis as unknown as { expensesBoss?: Promise<PgBoss> };
export async function getQueue() {
  if (!globalQueue.expensesBoss)
    globalQueue.expensesBoss = (async () => {
      const boss = new PgBoss({
        connectionString: config.databaseUrl,
        application_name: "expenses",
      });
      boss.on("error", () =>
        console.error("A background queue connection was interrupted."),
      );
      await boss.start();
      for (const name of [
        "bank-sync",
        "receipt-parse",
        "email-parse",
        "imap-sync",
        "lidl-sync",
        "maintenance",
      ])
        await boss.createQueue(name, {
          policy: "singleton",
          retryLimit: 4,
          retryDelay: 60,
          retryBackoff: true,
          expireInSeconds: 1800,
        });
      return boss;
    })().catch((error) => {
      globalQueue.expensesBoss = undefined;
      throw error;
    });
  return globalQueue.expensesBoss;
}
export async function enqueue(name: string, data: object, key: string) {
  return (await getQueue()).send(name, data, { singletonKey: key });
}
