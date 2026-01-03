/**
 * Tests for permission hook command classification
 *
 * Run with: npm test
 */

import { classifyCommand, type Classification } from "../permission-core.js";

// ============================================================================
// Test runner
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertLevel(cmd: string, expected: string, dangerous = false) {
  const result = classifyCommand(cmd);
  assertEqual(result.level, expected, `Command "${cmd}" level`);
  assertEqual(result.dangerous, dangerous, `Command "${cmd}" dangerous`);
}

async function runTests() {
  console.log("Running permission tests...\n");
  const results: TestResult[] = [];

  for (const { name, fn } of tests) {
    try {
      await fn();
      results.push({ name, passed: true });
      console.log(`  ${name}... ✓`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name, passed: false, error: message });
      console.log(`  ${name}... ✗`);
      console.log(`    ${message}`);
    }
  }

  console.log();
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// ============================================================================
// MINIMAL level tests - read-only commands
// ============================================================================

test("minimal: file reading commands", async () => {
  assertLevel("cat file.txt", "minimal");
  assertLevel("less file.txt", "minimal");
  assertLevel("more file.txt", "minimal");
  assertLevel("head -n 10 file.txt", "minimal");
  assertLevel("tail -f log.txt", "minimal");
  assertLevel("bat file.ts", "minimal");
});

test("minimal: directory listing commands", async () => {
  assertLevel("ls", "minimal");
  assertLevel("ls -la", "minimal");
  assertLevel("ls -la /tmp", "minimal");
  assertLevel("tree", "minimal");
  assertLevel("pwd", "minimal");
  assertLevel("cd /tmp", "minimal");
});

test("minimal: search commands", async () => {
  assertLevel("grep pattern file.txt", "minimal");
  assertLevel("grep -r pattern .", "minimal");
  assertLevel("grep -E 'foo|bar' file", "minimal");
  assertLevel("egrep pattern file", "minimal");
  assertLevel("rg pattern", "minimal");
  assertLevel("ag pattern", "minimal");
  assertLevel("find . -name '*.ts'", "minimal");
  assertLevel("fd pattern", "minimal");
  assertLevel("which node", "minimal");
  assertLevel("whereis git", "minimal");
});

test("minimal: info commands", async () => {
  assertLevel("echo hello", "minimal");
  assertLevel("printf '%s' hello", "minimal");
  assertLevel("whoami", "minimal");
  assertLevel("id", "minimal");
  assertLevel("date", "minimal");
  assertLevel("uname -a", "minimal");
  assertLevel("hostname", "minimal");
  assertLevel("uptime", "minimal");
  assertLevel("file image.png", "minimal");
  assertLevel("stat file.txt", "minimal");
  assertLevel("wc -l file.txt", "minimal");
  assertLevel("du -sh .", "minimal");
  assertLevel("df -h", "minimal");
});

test("minimal: process commands", async () => {
  assertLevel("ps aux", "minimal");
  assertLevel("top -l 1", "minimal");
  assertLevel("htop", "minimal");
  assertLevel("pgrep node", "minimal");
});

test("minimal: environment commands", async () => {
  assertLevel("env", "minimal");
  assertLevel("printenv", "minimal");
  assertLevel("set", "minimal");
});

test("minimal: pipeline utilities", async () => {
  assertLevel("sort file.txt", "minimal");
  assertLevel("uniq file.txt", "minimal");
  assertLevel("cut -d: -f1 /etc/passwd", "minimal");
  assertLevel("awk '{print $1}' file", "minimal");
  assertLevel("sed 's/foo/bar/' file", "minimal");
  assertLevel("tr a-z A-Z", "minimal");
  assertLevel("diff file1 file2", "minimal");
});

test("minimal: version checks", async () => {
  assertLevel("node --version", "minimal");
  assertLevel("npm -v", "minimal");
  assertLevel("python3 -V", "minimal");
  assertLevel("git --version", "minimal");
  assertLevel("rustc --version", "minimal");
});

test("minimal: git read operations", async () => {
  assertLevel("git status", "minimal");
  assertLevel("git log", "minimal");
  assertLevel("git log --oneline -10", "minimal");
  assertLevel("git diff", "minimal");
  assertLevel("git diff HEAD~1", "minimal");
  assertLevel("git show HEAD", "minimal");
  assertLevel("git branch", "minimal");
  assertLevel("git branch -a", "minimal");
  assertLevel("git remote -v", "minimal");
  assertLevel("git tag", "minimal");
  assertLevel("git ls-files", "minimal");
  assertLevel("git blame file.ts", "minimal");
  assertLevel("git reflog", "minimal");
});

test("minimal: package manager read operations", async () => {
  assertLevel("npm list", "minimal");
  assertLevel("npm ls", "minimal");
  assertLevel("npm info lodash", "minimal");
  assertLevel("npm outdated", "minimal");
  assertLevel("npm audit", "minimal");
  assertLevel("yarn list", "minimal");
  assertLevel("pnpm list", "minimal");
  assertLevel("pip list", "minimal");
  assertLevel("pip3 show requests", "minimal");
  assertLevel("cargo tree", "minimal");
  assertLevel("go list ./...", "minimal");
});

// ============================================================================
// MEDIUM level tests - dev operations
// ============================================================================

test("medium: npm install/build/test", async () => {
  assertLevel("npm install", "medium");
  assertLevel("npm install lodash", "medium");
  assertLevel("npm ci", "medium");
  assertLevel("npm test", "medium");
  assertLevel("npm build", "medium");
});

test("medium: npm run with safe scripts (build/test/lint)", async () => {
  assertLevel("npm run build", "medium");
  assertLevel("npm run test", "medium");
  assertLevel("npm run lint", "medium");
  assertLevel("npm run format", "medium");
  assertLevel("npm run check", "medium");
  assertLevel("npm run typecheck", "medium");
  assertLevel("npm run build:prod", "medium");
  assertLevel("npm run build:dev", "medium");
  assertLevel("npm run test:unit", "medium");
  assertLevel("npm run test:coverage", "medium");
  assertLevel("npm run lint:fix", "medium");
});

test("high: npm run with unsafe scripts (dev/start/serve)", async () => {
  assertLevel("npm run dev", "high");
  assertLevel("npm run start", "high");
  assertLevel("npm run serve", "high");
  assertLevel("npm run watch", "high");
  assertLevel("npm run preview", "high");
  assertLevel("npm run dev:server", "high");
  assertLevel("npm run start:dev", "high");
  assertLevel("npm run unknown-script", "high"); // unknown defaults to high
});

test("high: npm start/exec/npx (runs code)", async () => {
  assertLevel("npm start", "high"); // starts server
  assertLevel("npm exec", "high");
  assertLevel("npx create-react-app my-app", "high"); // npx runs packages
  assertLevel("npx ts-node script.ts", "high");
});

test("medium: yarn install/build/test", async () => {
  assertLevel("yarn install", "medium");
  assertLevel("yarn add lodash", "medium");
  assertLevel("yarn build", "medium");
  assertLevel("yarn test", "medium");
  assertLevel("yarn", "medium"); // bare yarn defaults to install
});

test("medium: yarn run with safe scripts", async () => {
  assertLevel("yarn run build", "medium");
  assertLevel("yarn run test", "medium");
  assertLevel("yarn run lint", "medium");
});

test("high: yarn run with unsafe scripts", async () => {
  assertLevel("yarn run dev", "high");
  assertLevel("yarn run start", "high");
  assertLevel("yarn start", "high");
  assertLevel("yarn dlx create-next-app", "high");
});

test("medium: pnpm install/build/test", async () => {
  assertLevel("pnpm install", "medium");
  assertLevel("pnpm add lodash", "medium");
  assertLevel("pnpm test", "medium");
  assertLevel("pnpm build", "medium");
});

test("medium: pnpm run with safe scripts", async () => {
  assertLevel("pnpm run build", "medium");
  assertLevel("pnpm run test", "medium");
  assertLevel("pnpm run lint", "medium");
});

test("high: pnpm run with unsafe scripts", async () => {
  assertLevel("pnpm run dev", "high");
  assertLevel("pnpm run start", "high");
  assertLevel("pnpm exec playwright", "high");
  assertLevel("pnpm dlx create-next-app", "high");
});

test("medium: bun install/build/test", async () => {
  assertLevel("bun install", "medium");
  assertLevel("bun add lodash", "medium");
  assertLevel("bun test", "medium");
  assertLevel("bun build", "medium");
});

test("medium: bun run with safe scripts", async () => {
  assertLevel("bun run build", "medium");
  assertLevel("bun run test", "medium");
  assertLevel("bun run lint", "medium");
});

test("high: bun run with unsafe scripts", async () => {
  assertLevel("bun run dev", "high");
  assertLevel("bun run start", "high");
  assertLevel("bun x create-next-app", "high");
  assertLevel("bunx create-next-app", "high");
});

test("medium: CocoaPods install/update", async () => {
  assertLevel("pod install", "medium");
  assertLevel("pod update", "medium");
  assertLevel("pod repo update", "medium");
});

test("high: pod commands that run code", async () => {
  // pod run doesn't exist - the correct way is to use xcodebuild or similar
  // But if someone tries to run arbitrary pod subcommands, they should be high
  assertLevel("pod run", "high");
  assertLevel("pod exec", "high");
});

test("medium: python install/test only", async () => {
  assertLevel("pip install requests", "medium");
  assertLevel("pip3 install requests", "medium");
  assertLevel("pytest", "medium");
  // pytest with flags - version check takes precedence for -v
  assertLevel("pytest --cov", "medium");
  assertLevel("pytest tests/", "medium");
  assertLevel("poetry install", "medium");
  assertLevel("poetry add requests", "medium");
  assertLevel("poetry build", "medium");
});

test("high: python/python3 (runs code)", async () => {
  assertLevel("python script.py", "high");
  assertLevel("python3 script.py", "high");
  assertLevel("python -c 'print(1)'", "high");
});

test("medium: rust build/test", async () => {
  assertLevel("cargo build", "medium");
  assertLevel("cargo test", "medium");
  assertLevel("cargo add serde", "medium");
  assertLevel("cargo check", "medium");
  assertLevel("cargo clippy", "medium");
  assertLevel("cargo fmt", "medium");
  assertLevel("rustc main.rs", "medium");
  assertLevel("rustfmt src/main.rs", "medium");
});

test("high: cargo run (runs code)", async () => {
  assertLevel("cargo run", "high");
  assertLevel("cargo run --release", "high");
});

test("medium: go build/test", async () => {
  assertLevel("go build", "medium");
  assertLevel("go test ./...", "medium");
  assertLevel("go get github.com/pkg/errors", "medium");
  assertLevel("go mod tidy", "medium");
  assertLevel("go fmt ./...", "medium");
  assertLevel("gofmt -w .", "medium");
});

test("high: go run (runs code)", async () => {
  assertLevel("go run main.go", "high");
  assertLevel("go run .", "high");
});

test("medium: build tools", async () => {
  assertLevel("make", "medium");
  assertLevel("make build", "medium");
  assertLevel("cmake .", "medium");
  assertLevel("ninja", "medium");
});

test("medium: linters and formatters", async () => {
  assertLevel("eslint .", "medium");
  assertLevel("prettier --write .", "medium");
  assertLevel("black .", "medium");
  assertLevel("flake8", "medium");
  assertLevel("mypy .", "medium");
  assertLevel("tsc", "medium");
});

test("medium: test runners", async () => {
  assertLevel("jest", "medium");
  assertLevel("mocha", "medium");
  assertLevel("vitest", "medium");
});

test("medium: file operations", async () => {
  assertLevel("mkdir new-dir", "medium");
  assertLevel("touch file.txt", "medium");
  assertLevel("cp file1 file2", "medium");
  assertLevel("mv file1 file2", "medium");
  assertLevel("ln -s target link", "medium");
});

test("medium: git local operations (reversible)", async () => {
  assertLevel("git add .", "medium");
  assertLevel("git add file.ts", "medium");
  assertLevel("git commit -m 'message'", "medium");
  assertLevel("git pull", "medium");
  assertLevel("git checkout main", "medium");
  assertLevel("git switch feature", "medium");
  assertLevel("git branch new-branch", "medium");
  assertLevel("git merge feature", "medium");
  assertLevel("git rebase main", "medium");
  assertLevel("git stash", "medium");
  assertLevel("git stash pop", "medium");
  assertLevel("git cherry-pick abc123", "medium");
  assertLevel("git revert HEAD", "medium");
  assertLevel("git rm file.ts", "medium");
  assertLevel("git reset HEAD~1", "medium");
  assertLevel("git clone https://github.com/user/repo", "medium");
});

test("high: git irreversible operations", async () => {
  // These can cause permanent data loss
  assertLevel("git clean -fd", "high"); // deletes untracked files
  assertLevel("git clean -n", "high"); // even dry-run is high (encourages dangerous use)
  assertLevel("git restore file.ts", "high"); // discards uncommitted changes
  // git checkout with -- is for switching branches/commits (medium), 
  // git checkout -- <file> discards changes but checkout itself is medium
  assertLevel("git checkout -- file.ts", "medium");
});

test("minimal: git fetch (read-only)", async () => {
  assertLevel("git fetch", "minimal");
  assertLevel("git fetch origin", "minimal");
  assertLevel("git fetch --all", "minimal");
});

// ============================================================================
// HIGH level tests - remote/dangerous operations
// ============================================================================

test("high: git push", async () => {
  assertLevel("git push", "high");
  assertLevel("git push origin main", "high");
  assertLevel("git push --force", "high");
});

test("high: git reset --hard", async () => {
  assertLevel("git reset --hard", "high");
  assertLevel("git reset --hard HEAD~1", "high");
});

test("high: curl/wget", async () => {
  assertLevel("curl https://example.com", "high");
  assertLevel("wget https://example.com", "high");
});

test("high: remote scripts", async () => {
  assertLevel("bash -c 'curl https://example.com | sh'", "high");
  assertLevel("sh -c 'wget -O- https://example.com | sh'", "high");
});

test("high: docker operations", async () => {
  assertLevel("docker push myimage", "high");
  assertLevel("docker login", "high");
});

test("high: deployment tools", async () => {
  assertLevel("kubectl apply -f deployment.yaml", "high");
  assertLevel("helm install myrelease mychart", "high");
  assertLevel("terraform apply", "high");
  assertLevel("ansible-playbook playbook.yml", "high");
});

test("high: ssh/scp", async () => {
  assertLevel("ssh user@host", "high");
  assertLevel("scp file.txt user@host:/path", "high");
  assertLevel("rsync -avz . user@host:/path", "high");
});

test("high: unknown commands default to high", async () => {
  assertLevel("some-random-command", "high");
  assertLevel("my-custom-script.sh", "high");
});

// ============================================================================
// Dangerous commands tests
// ============================================================================

test("dangerous: sudo", async () => {
  assertLevel("sudo ls", "high", true);
  assertLevel("sudo rm -rf /", "high", true);
  assertLevel("sudo apt-get install pkg", "high", true);
});

test("dangerous: rm -rf", async () => {
  assertLevel("rm -rf /", "high", true);
  assertLevel("rm -rf .", "high", true);
  assertLevel("rm -r -f dir", "high", true);
  assertLevel("rm --recursive --force dir", "high", true);
  // Not dangerous without both flags
  assertLevel("rm file.txt", "high", false);
  assertLevel("rm -r dir", "high", false);
  assertLevel("rm -f file.txt", "high", false);
});

test("dangerous: chmod 777", async () => {
  assertLevel("chmod 777 file", "high", true);
  assertLevel("chmod a+rwx file", "high", true);
  // Not dangerous
  assertLevel("chmod 644 file", "high", false);
  assertLevel("chmod +x file", "high", false);
});

test("dangerous: dd to device", async () => {
  assertLevel("dd if=/dev/zero of=/dev/sda", "high", true);
  assertLevel("dd if=file.img of=/dev/disk1", "high", true);
  // Not dangerous
  assertLevel("dd if=/dev/zero of=file.img", "high", false);
});

test("dangerous: system commands", async () => {
  assertLevel("mkfs.ext4 /dev/sda1", "high", true);
  assertLevel("fdisk /dev/sda", "high", true);
  assertLevel("shutdown now", "high", true);
  assertLevel("reboot", "high", true);
  assertLevel("halt", "high", true);
  assertLevel("poweroff", "high", true);
});

// ============================================================================
// Shell tricks tests - command substitution
// ============================================================================

test("shell tricks: $() command substitution", async () => {
  assertLevel("echo $(whoami)", "high");
  assertLevel("echo $(rm -rf /)", "high");
  assertLevel("ls $(pwd)", "high");
});

test("shell tricks: backtick substitution", async () => {
  assertLevel("echo `whoami`", "high");
  assertLevel("echo `rm -rf /`", "high");
  assertLevel("ls `pwd`", "high");
});

test("shell tricks: process substitution", async () => {
  assertLevel("cat <(ls)", "high");
  assertLevel("diff <(ls dir1) <(ls dir2)", "high");
  assertLevel("tee >(cat)", "high");
});

test("shell tricks: eval and source", async () => {
  assertLevel("eval 'ls'", "high");
  assertLevel("eval 'rm -rf /'", "high");
  assertLevel("source script.sh", "high");
  assertLevel(". script.sh", "high");
  assertLevel("exec bash", "high");
});

test("shell tricks: nested command substitution in ${}", async () => {
  assertLevel("echo ${PATH:-$(whoami)}", "high");
  assertLevel("echo ${VAR:-`id`}", "high");
});

// ============================================================================
// Safe patterns tests - should NOT trigger shell tricks
// ============================================================================

test("safe: simple variable expansion", async () => {
  assertLevel("echo $PATH", "minimal");
  assertLevel("echo $HOME", "minimal");
  assertLevel("echo $USER", "minimal");
});

test("safe: ${VAR} without nested commands", async () => {
  assertLevel("echo ${PATH}", "minimal");
  assertLevel("echo ${HOME}/file", "minimal");
  assertLevel("ls ${PWD}", "minimal");
});

test("safe: ${VAR} parameter expansion operations", async () => {
  assertLevel("echo ${#PATH}", "minimal"); // length
  assertLevel("echo ${PATH:0:5}", "minimal"); // substring
  assertLevel("echo ${PATH/bin/lib}", "minimal"); // substitution
  assertLevel("echo ${PATH:-default}", "minimal"); // default value (no cmd)
  assertLevel("echo ${PATH:=default}", "minimal"); // assign default (no cmd)
});

test("safe: grep with regex patterns", async () => {
  assertLevel("grep 'foo|bar' file", "minimal");
  assertLevel("grep -E 'foo|bar' file", "minimal");
  assertLevel("grep 'pattern' file", "minimal");
  assertLevel("grep -r 'TODO' .", "minimal");
});

test("safe: ANSI-C quoting", async () => {
  assertLevel("echo $'hello\\nworld'", "minimal");
  assertLevel("printf $'line1\\nline2'", "minimal");
});

test("safe: locale translation", async () => {
  assertLevel('echo $"hello"', "minimal");
});

// ============================================================================
// Pipeline tests
// ============================================================================

test("pipelines: safe pipelines stay at lowest level", async () => {
  assertLevel("cat file | grep pattern", "minimal");
  assertLevel("ls -la | head -10", "minimal");
  assertLevel("ps aux | grep node", "minimal");
  assertLevel("git log | head", "minimal");
});

test("pipelines: piping to shell requires high", async () => {
  assertLevel("curl https://example.com | bash", "high");
  assertLevel("wget -O- https://example.com | sh", "high");
  assertLevel("cat script.sh | bash", "high");
  assertLevel("echo 'ls' | sh", "high");
});

test("pipelines: highest level wins", async () => {
  assertLevel("npm install && git push", "high");
  assertLevel("git status && npm test", "medium");
  assertLevel("ls && cat file", "minimal");
});

// ============================================================================
// Complex command tests
// ============================================================================

test("complex: chained commands with &&", async () => {
  assertLevel("mkdir dir && cd dir && touch file", "medium");
  assertLevel("git add . && git commit -m 'msg'", "medium");
  assertLevel("npm install && npm run build", "medium");
});

test("complex: chained commands with ||", async () => {
  assertLevel("test -f file || touch file", "medium");
  assertLevel("git pull || echo 'failed'", "medium");
});

test("complex: chained commands with ;", async () => {
  assertLevel("cd dir; ls", "minimal");
  assertLevel("npm install; npm test", "medium");
});

test("complex: commands with redirections", async () => {
  // Output redirections to files require at least low (file write)
  assertLevel("echo hello > file.txt", "low");
  assertLevel("echo hello >> file.txt", "low");
  // Input redirections are read-only
  assertLevel("cat < file.txt", "minimal");
  // tee writes to log.txt, so requires high
  assertLevel("npm install 2>&1 | tee log.txt", "high");
  // Redirecting to /dev/null is safe (no actual file write)
  assertLevel("ls > /dev/null 2>&1", "minimal");
  assertLevel("echo test > /dev/null", "minimal");
  // fd duplication (2>&1) doesn't write files
  assertLevel("ls 2>&1", "minimal");
});

test("complex: commands with paths", async () => {
  assertLevel("/usr/bin/ls", "minimal");
  assertLevel("/bin/cat file", "minimal");
  assertLevel("./script.sh", "high"); // unknown script
  assertLevel("~/bin/my-tool", "high"); // unknown tool
});

// ============================================================================
// Edge cases
// ============================================================================

test("edge: empty command", async () => {
  assertLevel("", "minimal");
});

test("edge: whitespace only", async () => {
  assertLevel("   ", "minimal");
});

test("edge: command with leading backslash (alias bypass)", async () => {
  assertLevel("\\ls", "minimal");
  assertLevel("\\rm file", "high");
});

test("edge: shell-quote parse failures are high", async () => {
  // Complex patterns that shell-quote can't parse should be treated as dangerous
  assertLevel("echo ${PATH:-$(whoami)}", "high");
});

// ============================================================================
// Additional edge cases
// ============================================================================

test("edge: git branch/tag/remote with and without args", async () => {
  // Listing (off)
  assertLevel("git branch", "minimal");
  assertLevel("git branch -a", "minimal");
  assertLevel("git branch --list", "minimal");
  assertLevel("git tag", "minimal");
  assertLevel("git tag -l", "minimal");
  assertLevel("git remote", "minimal");
  assertLevel("git remote -v", "minimal");
  // Creating (medium)
  assertLevel("git branch new-branch", "medium");
  assertLevel("git branch -d old-branch", "medium");
  assertLevel("git tag v1.0.0", "medium");
  assertLevel("git tag -a v1.0.0 -m 'msg'", "medium");
  // remote add is not in medium git subcommands, defaults to high
  assertLevel("git remote add origin url", "high");
});

test("edge: rm edge cases", async () => {
  // Not dangerous (missing -f or -r)
  assertLevel("rm file.txt", "high", false);
  assertLevel("rm -r dir", "high", false);
  assertLevel("rm -f file.txt", "high", false);
  assertLevel("rm -i file.txt", "high", false);
  // Dangerous (both -r and -f)
  assertLevel("rm -rf dir", "high", true);
  assertLevel("rm -fr dir", "high", true);
  assertLevel("rm -r -f dir", "high", true);
  assertLevel("rm -f -r dir", "high", true);
  assertLevel("rm --recursive --force dir", "high", true);
  assertLevel("rm -rf --no-preserve-root /", "high", true);
});

test("edge: special characters in paths", async () => {
  assertLevel("cat 'file with spaces.txt'", "minimal");
  assertLevel('cat "file with spaces.txt"', "minimal");
  assertLevel("ls dir\\ with\\ spaces", "minimal");
  assertLevel("cat file-with-dashes.txt", "minimal");
  assertLevel("cat file_with_underscores.txt", "minimal");
});

test("edge: absolute and relative paths", async () => {
  assertLevel("/bin/ls", "minimal");
  assertLevel("/usr/bin/cat file", "minimal");
  assertLevel("./local-script.sh", "high"); // unknown script
  assertLevel("../parent-script.sh", "high"); // unknown script
  assertLevel("~/bin/my-tool", "high"); // unknown tool
});

test("edge: environment variable assignment", async () => {
  // Environment variable assignment is complex shell syntax
  // shell-quote may not parse it correctly, so these default to high
  assertLevel("FOO=bar ls", "high");
  assertLevel("NODE_ENV=production npm test", "high");
  assertLevel("DEBUG=* node app.js", "high");
});

test("edge: subshells and grouping", async () => {
  // Subshell with () - shell-quote parses the inner commands
  assertLevel("(cd dir && ls)", "minimal");
  // Command grouping with {} - the { is parsed as unknown command, defaults to high
  assertLevel("{ ls; pwd; }", "high");
});

test("edge: here documents and strings", async () => {
  // Here documents - << is parsed, cat is off
  assertLevel("cat << EOF", "minimal");
  // Here strings <<< - complex syntax, defaults to high
  assertLevel("cat <<< 'hello'", "high");
});

test("edge: multiple redirections", async () => {
  assertLevel("cmd > out.txt 2> err.txt", "high"); // unknown cmd is high anyway
  // Output to file requires low, but ls is minimal so result is low
  assertLevel("ls > out.txt 2>&1", "low");
  // stderr to /dev/null is safe
  assertLevel("cat file 2>/dev/null", "minimal");
  // Append to file requires low
  assertLevel("echo hello >> append.txt", "low");
});

test("edge: npm/yarn scripts with special names", async () => {
  assertLevel("npm run build:prod", "medium");
  assertLevel("npm run test:coverage", "medium");
  // yarn without 'run' requires exact match of known subcommands
  // build:dev doesn't match, so it's high
  assertLevel("yarn build:dev", "high");
  assertLevel("yarn run build:dev", "medium"); // with 'run' it works
  assertLevel("pnpm run lint:fix", "medium");
});

test("edge: docker non-push commands", async () => {
  assertLevel("docker build .", "high");
  assertLevel("docker run nginx", "high");
  assertLevel("docker ps", "high");
  assertLevel("docker images", "high");
  // These are explicitly high
  assertLevel("docker push myimage", "high");
  assertLevel("docker login", "high");
});

test("edge: chmod variations", async () => {
  // Dangerous
  assertLevel("chmod 777 file", "high", true);
  assertLevel("chmod a+rwx file", "high", true);
  // Not dangerous
  assertLevel("chmod 755 file", "high", false);
  assertLevel("chmod 644 file", "high", false);
  assertLevel("chmod +x script.sh", "high", false);
  assertLevel("chmod u+x script.sh", "high", false);
  assertLevel("chmod go-w file", "high", false);
});

test("edge: nested command substitution variations", async () => {
  assertLevel("echo $(echo $(whoami))", "high");
  assertLevel("echo `echo \\`whoami\\``", "high");
  assertLevel("VAR=$(cmd)", "high");
  assertLevel("export PATH=$(pwd):$PATH", "high");
});

test("edge: arithmetic expansion", async () => {
  // Arithmetic expansion $((...)) looks like command substitution to regex
  // This is a known limitation - we err on the side of caution
  assertLevel("echo $((1 + 2))", "high");
  assertLevel("echo $((10 * 5))", "high");
});

test("edge: brace expansion (safe)", async () => {
  assertLevel("echo {a,b,c}", "minimal");
  assertLevel("touch file{1,2,3}.txt", "medium");
  assertLevel("cp file.{txt,bak}", "medium");
});

test("edge: glob patterns (safe)", async () => {
  assertLevel("ls *.txt", "minimal");
  assertLevel("cat src/**/*.ts", "minimal");
  assertLevel("rm *.tmp", "high"); // rm is high, but not dangerous without -rf
});

test("edge: xargs with read-only commands (minimal)", async () => {
  // xargs running read-only commands from MINIMAL_COMMANDS is safe
  assertLevel("xargs cat", "minimal");
  assertLevel("xargs head", "minimal");
  assertLevel("xargs tail", "minimal");
  assertLevel("xargs grep pattern", "minimal");
  assertLevel("xargs wc -l", "minimal");
  assertLevel("xargs ls", "minimal");
  assertLevel("xargs echo", "minimal");
  // No command = defaults to /bin/echo (safe)
  assertLevel("xargs", "minimal");
  // Pipelines with xargs + read-only command
  assertLevel("find . -name '*.txt' | xargs cat", "minimal");
  assertLevel("find . -name '*.ts' | xargs head -10", "minimal");
  assertLevel("find . -type f | xargs wc -l", "minimal");
});

test("edge: xargs with flags and read-only commands (minimal)", async () => {
  // Various xargs flags should not affect classification
  assertLevel("xargs -0 cat", "minimal");
  assertLevel("xargs -n 1 cat", "minimal");
  assertLevel("xargs -P 4 cat", "minimal");
  assertLevel("xargs -I {} cat {}", "minimal");
  assertLevel("xargs -I{} cat {}", "minimal");  // attached argument
  assertLevel("xargs -d '\\n' cat", "minimal");
  assertLevel("xargs --null cat", "minimal");
  assertLevel("xargs -0 -n 1 -P 4 cat", "minimal");  // multiple flags
  assertLevel("xargs -- cat", "minimal");  // explicit end of options
  assertLevel("xargs -t cat", "minimal");  // verbose mode
  assertLevel("xargs -p cat", "minimal");  // interactive mode (still read-only)
});

test("edge: xargs with full paths to read-only commands (minimal)", async () => {
  assertLevel("xargs /bin/cat", "minimal");
  assertLevel("xargs /usr/bin/cat", "minimal");
  assertLevel("xargs /usr/bin/head", "minimal");
});

test("edge: xargs with non-read-only commands (high)", async () => {
  // rm is not in MINIMAL_COMMANDS
  assertLevel("xargs rm", "high");
  assertLevel("find . -name '*.txt' | xargs rm", "high");
  // shell commands can run anything
  assertLevel("xargs sh -c 'cat'", "high");
  assertLevel("xargs bash -c 'ls'", "high");
  // interpreters run code
  assertLevel("xargs node", "high");
  assertLevel("xargs python", "high");
  assertLevel("xargs python3", "high");
  // unknown commands default to high
  assertLevel("xargs unknown-cmd", "high");
  assertLevel("xargs my-script.sh", "high");
});

test("edge: xargs with redirections", async () => {
  // Output redirection makes it LOW (file write detected via shell redirection)
  assertLevel("xargs cat > output.txt", "low");
  assertLevel("xargs cat >> append.txt", "low");
  assertLevel("find . | xargs cat > all.txt", "low");
  assertLevel("xargs -I {} cat {} > {}.bak", "low");
  
  // Stderr to /dev/null is safe (no actual file write)
  assertLevel("xargs cat 2>/dev/null", "minimal");
  assertLevel("find . | xargs cat 2>/dev/null", "minimal");
  
  // Pipe to another command is safe (no file write)
  assertLevel("xargs cat | head -10", "minimal");
  assertLevel("xargs cat | grep pattern", "minimal");
  assertLevel("find . | xargs cat | wc -l", "minimal");
  
  // Redirect to /dev/null is safe
  assertLevel("xargs cat > /dev/null", "minimal");
});

test("edge: cat with redirections (not xargs)", async () => {
  // Ensure cat itself is correctly classified with redirections
  assertLevel("cat file.txt", "minimal");
  assertLevel("cat file1 file2", "minimal");
  assertLevel("cat file1 > file2", "low");  // write via redirection
  assertLevel("cat file >> append.txt", "low");  // append via redirection
  assertLevel("cat < input.txt", "minimal");  // input redirection is read-only
  assertLevel("cat file 2>/dev/null", "minimal");  // stderr to /dev/null is safe
  assertLevel("cat file > /dev/null", "minimal");  // /dev/null is safe
  assertLevel("cat file | grep pattern", "minimal");  // pipe is read-only
});

test("edge: tee command (writes files)", async () => {
  // tee with file arguments writes to those files - requires high
  assertLevel("echo hello | tee file.txt", "high");
  assertLevel("npm install 2>&1 | tee log.txt", "high");
  // tee to /dev/null only is safe (no file write)
  assertLevel("echo hello | tee /dev/null", "minimal");
  // tee with no args just passes through (stdout only)
  assertLevel("echo hello | tee", "minimal");
});

test("edge: common CI/CD commands", async () => {
  assertLevel("npm ci", "medium");
  assertLevel("npm run lint", "medium");
  assertLevel("npm run test -- --coverage", "medium");
  // npx runs arbitrary packages, so it's high
  assertLevel("npx jest --watchAll", "high");
  assertLevel("yarn install --frozen-lockfile", "medium");
});

test("edge: database commands", async () => {
  assertLevel("psql -c 'SELECT 1'", "high");
  assertLevel("mysql -e 'SHOW TABLES'", "high");
  assertLevel("sqlite3 db.sqlite", "high");
  assertLevel("mongosh", "high");
  assertLevel("redis-cli", "high");
});

test("edge: prisma commands", async () => {
  assertLevel("prisma generate", "medium");
  assertLevel("prisma migrate dev", "medium");
  assertLevel("prisma db push", "medium");
  assertLevel("prisma studio", "medium");
});

test("edge: case sensitivity", async () => {
  // Commands are normalized to lowercase, so LS == ls
  assertLevel("LS", "minimal");
  assertLevel("Cat file", "minimal");
  assertLevel("GIT status", "minimal");
});

test("edge: Windows-style paths (cross-platform)", async () => {
  // These might appear in cross-platform scenarios
  assertLevel("cat C:\\Users\\file.txt", "minimal");
});

test("edge: comments in commands", async () => {
  assertLevel("ls # this is a comment", "minimal");
  assertLevel("echo hello # comment", "minimal");
});

test("edge: multiline commands (escaped newlines)", async () => {
  assertLevel("ls \\\n  -la", "minimal");
});

test("edge: doas (OpenBSD sudo alternative)", async () => {
  // doas should be treated like sudo - currently not, this documents behavior
  const result = classifyCommand("doas ls");
  // Note: doas is not in SHELL_EXECUTION_COMMANDS, defaults to high but not dangerous
  assertEqual(result.level, "high", "doas level");
});

test("edge: nohup and background commands", async () => {
  assertLevel("nohup npm start &", "high");
  // npm start runs a server, so it's high regardless of &
  assertLevel("npm start &", "high");
  // Background safe command
  assertLevel("npm run build &", "medium");
});

test("edge: time and timeout wrappers", async () => {
  assertLevel("time ls", "high"); // time is not in MINIMAL
  assertLevel("timeout 10 npm test", "high"); // timeout is not in MINIMAL
});

test("edge: exec variants", async () => {
  assertLevel("exec bash", "high");
  assertLevel("exec > log.txt", "high");
});

test("edge: find with -exec/-delete (can modify filesystem)", async () => {
  // find without dangerous flags is minimal (read-only search)
  assertLevel("find . -name '*.txt'", "minimal");
  assertLevel("find . -type f -name '*.ts'", "minimal");
  // find with -exec/-execdir/-ok/-okdir/-delete requires high (can execute/delete)
  assertLevel("find . -name '*.txt' -exec cat {} \\;", "high");
  assertLevel("find . -type f -exec rm {} \\;", "high");
  assertLevel("find . -name '*.tmp' -delete", "high");
  assertLevel("find . -type f -execdir mv {} {}.bak \\;", "high");
  assertLevel("find . -name '*.txt' -ok rm {} \\;", "high");
});

test("edge: very long commands", async () => {
  const longCmd = "echo " + "a".repeat(10000);
  assertLevel(longCmd, "minimal");
});

test("edge: unicode in commands", async () => {
  assertLevel("echo '你好世界'", "minimal");
  assertLevel("cat файл.txt", "minimal");
  assertLevel("ls 📁", "minimal");
});

test("edge: null bytes and special chars", async () => {
  assertLevel("echo 'hello\x00world'", "minimal");
});

// ============================================================================
// Happy path comprehensive tests
// ============================================================================

test("happy: typical development workflow", async () => {
  // Clone (medium - reversible, just creates directory)
  assertLevel("git clone https://github.com/user/repo", "medium");
  assertLevel("cd repo", "minimal");
  assertLevel("npm install", "medium");
  
  // Development - run dev is high (runs server)
  assertLevel("npm run dev", "high");
  assertLevel("npm run build", "medium");
  assertLevel("npm test", "medium");
  assertLevel("git status", "minimal");
  assertLevel("git diff", "minimal");
  assertLevel("git add .", "medium");
  assertLevel("git commit -m 'feat: add feature'", "medium");
  assertLevel("git push origin main", "high");
});

test("happy: code review workflow", async () => {
  // fetch is read-only
  assertLevel("git fetch origin", "minimal");
  assertLevel("git checkout -b review/pr-123", "medium");
  assertLevel("git log --oneline -20", "minimal");
  assertLevel("git diff main..HEAD", "minimal");
  assertLevel("grep -r 'TODO' src/", "minimal");
  assertLevel("npm test", "medium");
});

test("happy: debugging session", async () => {
  assertLevel("cat src/index.ts", "minimal");
  assertLevel("grep -n 'error' logs/*.log", "minimal");
  assertLevel("tail -f logs/app.log", "minimal");
  assertLevel("ps aux | grep node", "minimal");
  assertLevel("lsof -i :3000", "high"); // lsof not in MINIMAL
});

test("happy: Python development", async () => {
  // python3 -m venv creates venv, python3 runs code - both high
  assertLevel("python3 -m venv .venv", "high");
  assertLevel("pip install -r requirements.txt", "medium");
  // Running python is high (runs code)
  assertLevel("python3 app.py", "high");
  assertLevel("pytest", "medium");
  assertLevel("pytest tests/", "medium");
  assertLevel("black .", "medium");
  assertLevel("mypy src/", "medium");
});

test("happy: Rust development", async () => {
  // cargo new is high (not in medium patterns)
  assertLevel("cargo new myproject", "high");
  assertLevel("cargo build", "medium");
  // cargo run is high (runs code)
  assertLevel("cargo run", "high");
  assertLevel("cargo test", "medium");
  assertLevel("cargo clippy", "medium");
  assertLevel("cargo fmt", "medium");
  assertLevel("cargo add serde", "medium");
});

test("happy: Go development", async () => {
  assertLevel("go mod init myproject", "medium");
  assertLevel("go get github.com/gin-gonic/gin", "medium");
  assertLevel("go build", "medium");
  // go run is high (runs code)
  assertLevel("go run .", "high");
  assertLevel("go test ./...", "medium");
  assertLevel("go fmt ./...", "medium");
});

// ============================================================================
// Run tests
// ============================================================================

runTests();
