import { assertConfig } from "../src/server/config";
import { migrate, pool } from "../src/server/db";
import { saveLidl, syncLidl, lidlStatus } from "../src/server/lidl";
import { getQueue } from "../src/server/queue";

assertConfig();
const user = process.env.LIDL_USERNAME;
const password = process.env.LIDL_PASSWORD;
if (Boolean(user) !== Boolean(password))
  throw new Error(
    "Set both LIDL_USERNAME and LIDL_PASSWORD, or omit both to use the saved connection.",
  );
try {
  await migrate();
  if (user && password)
    await saveLidl({
      user: user.trim().toLowerCase(),
      password,
      enabled: true,
    });
  else if (!(await lidlStatus())?.enabled)
    throw new Error("Save and enable your Lidl connection in Settings first.");
  if (process.argv.includes("--interactive"))
    console.log(
      "Complete any verification in the Chromium window. The session will be saved encrypted when sign-in finishes.",
    );
  await syncLidl(process.argv.includes("--interactive"));
  const status = await lidlStatus();
  console.log(
    `Lidl connected. Last successful import: ${status?.lastSyncAt || "none"}.`,
  );
} catch {
  console.error(
    "Lidl connection could not complete. Check Settings → Lidl Plus receipts for the recorded error.",
  );
  process.exitCode = 1;
} finally {
  await (await getQueue()).stop({ graceful: true, timeout: 20000 });
  await pool.end();
}
