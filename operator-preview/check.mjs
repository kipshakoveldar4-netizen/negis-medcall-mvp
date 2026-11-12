import { requireOperatorPreview } from "./profile.mjs";

try {
  requireOperatorPreview(process.env, "build");
  process.stdout.write("Operator Preview build target verified.\n");
} catch (error) {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
}
