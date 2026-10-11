import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_COMMAND_LENGTH,
  MAX_NESTING,
  bashGuard,
  scanDeletes,
  unguardedDelete,
} from "../src/jev/hooks/bash-guard.js";

/** The fifth review's 24 probe cases. */
const PROBE: readonly (readonly [string, "deny" | "allow"])[] = [
  ['rm -rf "$1"/*', "deny"],
  ["rm -rf $@", "deny"],
  ['/bin/rm -rf "$DIR"', "deny"],
  ['\\rm -rf "$DIR"', "deny"],
  ['command rm -rf "$DIR"', "deny"],
  ['rm -rf \\\n  "$DIR"/', "deny"],
  ["find $DIR -delete", "allow"],
  ['xargs -0 rm -rf <<< "$DIR"', "deny"],
  ['rm -rf "${DIR}"', "deny"],
  ["rm -rf ${DIR:-/tmp/x}", "deny"],
  ['env FOO=1 rm -rf "$DIR"', "deny"],
  ['if true; then rm -rf "$D"; fi', "deny"],
  ['rm -rf "`echo $D`"', "deny"],
  ['git rm --cached "$FILE"', "allow"],
  ["docker rm -f $CID", "allow"],
  ["npm rm $PKG", "allow"],
  ['echo "remove with: rm $X"', "allow"],
  ["rm -f build/out.txt  # cleans $HOME cache", "allow"],
  ['rm -rf "${DIR:?}/build"', "allow"],
  ["rm -f '/tmp/$literal'", "allow"],
  ["kubectl delete pod $POD", "allow"],
  ["cargo rm $CRATE", "allow"],
  ["pnpm rm $(cat list)", "allow"],
  ["rm /tmp/a.txt && echo $HOME", "allow"],
];

/** Further cases: wrappers, separators, positional parameters, guards. */
const MORE: readonly (readonly [string, "deny" | "allow"])[] = [
  // every deleter, by path and through wrappers
  ["rmdir $D", "deny"],
  ["unlink $LINK", "deny"],
  ["shred -u $F", "deny"],
  ['/usr/bin/rm -rf "$DIR"', "deny"],
  ["sudo rm -rf $HOME/cache", "deny"],
  ["sudo -u root rm -rf $D", "deny"],
  ["doas rm $D", "deny"],
  ["timeout 300 rm -rf $D", "deny"],
  ["nohup rm -rf $D", "deny"],
  ["nice -n 5 rm -rf $D", "deny"],
  ["env -i PATH=/bin rm $D", "deny"],
  ["echo x | xargs rm -rf $EXTRA", "deny"],
  ["find . -name '*.tmp' | xargs rm -f $EXTRA", "deny"],
  // after every separator
  ["true; rm -rf $D", "deny"],
  ["true && rm -rf $D", "deny"],
  ["false || rm -rf $D", "deny"],
  ["ls | rm -rf $D", "deny"],
  ["(rm -rf $D)", "deny"],
  ["{ rm -rf $D; }", "deny"],
  ["sleep 1 & rm -rf $D", "deny"],
  ["for f in *.log; do rm $f; done", "deny"],
  ["if rm -rf $D; then echo ok; fi", "deny"],
  ["echo $(rm -rf $D)", "deny"],
  ["echo `rm -rf $D`", "deny"],
  ["cd /tmp &&\\\n rm -rf $D", "deny"],
  // every expansion form
  ["rm -rf $9", "deny"],
  ['rm -rf "$*"', "deny"],
  ['rm -rf "$@"', "deny"],
  ["rm -rf ${D}/build", "deny"],
  ["rm -rf ${D:=x}", "deny"],
  ['rm -rf "$TARGET/build"', "deny"],
  ['rm -rf "${TARGET}/build"', "deny"],
  // a guarded variable alone or with a literal path passes; a bare slash or a glob after it does not
  ['rm -rf "${DIR:?}"', "deny"],
  ['rm -rf /tmp/"${NAME:?}"', "allow"],
  ['rm -rf "${DIR:?}".bak', "allow"],
  ['rm -rf "${DIR:?}"/', "deny"],
  ['rm -rf "${DIR:?}"/*', "deny"],
  ["rm -rf ${DIR:?}/*.log", "deny"],
  ['rm -rf "${DIR:?}/build"/*', "deny"],
  ['rm -rf "${DIR:?missing}/build"', "allow"],
  ['rm -rf "${1:?}/build"', "allow"],
  ['rm -rf "${A:?}/x" "${B:?}/y"', "allow"],
  ['rm -rf "${A:?}${B:?}/y"', "allow"],
  ['rm -rf "${A:?}/$B"', "deny"],
  ['rm -rf "${A:?}/x" "$B"', "deny"],
  // not deletes, or no live variable
  ["rm -rf /tmp/literal/path", "allow"],
  ["rmdir build", "allow"],
  ["ls $HOME", "allow"],
  ["echo 'rm -rf $NOT_A_COMMAND'", "allow"],
  ["sh -c 'rm -rf $D'", "allow"],
  ["rm -rf /tmp/x\\$y", "allow"],
  ['rm -f "/tmp/a b"  # $X', "allow"],
  ["rm -f /tmp/x 2>$LOG", "allow"],
  ["rm -f /tmp/x > $LOG", "allow"],
  ["git rm -r $DIR", "allow"],
  ["yarn remove $PKG && npm rm $PKG", "allow"],
  ["kubectl delete -f $FILE", "allow"],
  ['echo "a | rm $X"', "allow"],
  ["echo 'a; rm $X'", "allow"],
  ["grep -rn rm $FILE", "allow"],
  ["rm /tmp/$$.lock", "allow"],
  ["rm -f $(mktemp -u)", "allow"],
];

test("the delete guard decides all 24 probe cases of the fifth review", () => {
  for (const [command, want] of PROBE)
    assert.equal(
      unguardedDelete(command) === undefined ? "allow" : "deny",
      want,
      JSON.stringify(command),
    );
});

test("the delete guard reads wrappers, separators, expansion forms and guards", () => {
  for (const [command, want] of MORE)
    assert.equal(
      unguardedDelete(command) === undefined ? "allow" : "deny",
      want,
      JSON.stringify(command),
    );
});

test("the refusal names the offending simple command, not the whole line", () => {
  assert.equal(
    unguardedDelete('cd /tmp && rm -rf "$DIR" ; echo done'),
    'rm -rf "$DIR"',
  );
  const denied = bashGuard(
    JSON.stringify({
      session_id: "s",
      cwd: "/nonexistent",
      tool_name: "Bash",
      tool_input: { command: 'ls; /bin/rm -rf "$1"/*' },
    }),
    "claude",
  );
  assert.match(denied.stdout ?? "", /"permissionDecision":"deny"/u);
  assert.match(
    denied.stdout ?? "",
    /Refused a delete through a variable path \(\/bin\/rm -rf \\"\$1\\"\/\*\)\. Rewrite it with literal absolute paths/u,
  );
  const allowed = bashGuard(
    JSON.stringify({
      session_id: "s",
      cwd: "/nonexistent",
      tool_name: "Bash",
      tool_input: { command: 'git rm --cached "$FILE"' },
    }),
    "claude",
  );
  assert.equal(allowed.stdout, undefined);
  assert.equal(allowed.exitCode, 0);
});

/** The sixth review: function bodies, case arms, coproc and setsid, guarded-path holes, and data the old scan misread. */
const REVIEW6: readonly (readonly [string, "deny" | "allow"])[] = [
  // deletes inside function bodies, case arms and more wrappers
  ["f() { rm -rf $tmp; }", "deny"],
  ['cleanup() { rm -rf "$tmp"; }; trap cleanup EXIT', "deny"],
  ["f() (rm $D)", "deny"],
  ['case x in *) rm -rf "$tmp";; esac', "deny"],
  ["case $x in (a|b) rm $D;; c) true;; esac", "deny"],
  ["case $x in a) true;& b) rm $D;; esac", "deny"],
  ["echo $(case x in *) echo;; esac); rm $D", "deny"],
  ["coproc rm -rf $tmp", "deny"],
  ["coproc C { rm -rf $D; }", "deny"],
  ["setsid rm -rf $tmp", "deny"],
  ["setsid -w rm -rf $tmp", "deny"],
  ["ionice -c3 rm -rf $D", "deny"],
  ["stdbuf -o0 rm -rf $D", "deny"],
  ["chrt -i 0 rm -rf $D", "deny"],
  ["taskset 0x3 rm -rf $D", "deny"],
  ["busybox rm -rf $D", "deny"],
  ["cat <(rm -rf $D)", "deny"],
  ['xargs -0 rm -rf <<< "$D"', "deny"],
  // guarded variables that still name a whole tree or step out of it
  ['rm -rf "${D:?}/.."', "deny"],
  ['rm -rf "${D:?}"/..', "deny"],
  ['rm -rf "${D:?}"/./', "deny"],
  ['rm -rf "${D:?}"/../*', "deny"],
  ['rm -rf "${D:?}${E:?}"', "deny"],
  ['rm -rf "$0"', "deny"],
  ['rm -rf "${0:?}/build"', "allow"],
  // here-documents: bodies are data, but an unquoted body's substitutions run
  ["cat > s.sh <<'EOF'\nrm -rf $D\nEOF", "allow"],
  ['cat <<-"EOF"\n\trm $D\n\tEOF', "allow"],
  ["cat <<EOF\nrm -rf $D\nEOF", "allow"],
  ["x=$(cat <<'E'\nrm $D\nE\n)", "allow"],
  ["cat <<EOF\n$(rm -rf $D)\nEOF", "deny"],
  ["cat <<'EOF'\n$(rm -rf $D)\nEOF", "allow"],
  ["cat <<EOF\nnotes\nEOF\nrm -rf $X", "deny"],
  ["cat <<A <<'B'\nrm $D\nA\nrm $E\nB\nrm $F", "deny"],
  // a here-document whose delimiter never comes is read as commands
  ["echo $((1<<2))\nrm -rf $D", "deny"],
  // ANSI-C quoted text is literal; `command -v` runs nothing
  ["rm -f $'a b'", "allow"],
  ["rm -f $'a\\'b $X'", "allow"],
  ["rm -f $'a b' $D", "deny"],
  ["command -v rm $D", "allow"],
  ["command -V rm", "allow"],
  ["command -p rm $D", "deny"],
];

test("the delete guard decides the sixth review's cases", () => {
  for (const [command, want] of REVIEW6)
    assert.equal(
      unguardedDelete(command) === undefined ? "allow" : "deny",
      want,
      JSON.stringify(command),
    );
});

test("the delete guard scans in linear time and fails open quickly past its limits", () => {
  const timed = (command: string) => {
    const started = performance.now();
    const scan = scanDeletes(command);
    return { scan, seconds: (performance.now() - started) / 1000 };
  };
  const variable = "$" + "D";
  const remove = `r${"m"} -rf ${variable}`;
  // Just under the size limit, a delete at the very end is still found.
  const wide = timed(`echo ${"$(echo a) ".repeat(99_000)}; ${remove}`);
  assert.ok(wide.seconds < 1, `${wide.seconds}s`);
  assert.equal(wide.scan.offending, remove);
  const heredocs = timed(`${"cat <<X\n".repeat(100_000)}${remove}`);
  assert.ok(heredocs.seconds < 1, `${heredocs.seconds}s`);
  assert.equal(heredocs.scan.offending, remove);
  // Past the limits nothing is scanned.
  for (const command of [
    "x".repeat(MAX_COMMAND_LENGTH + 1),
    `${"$(".repeat(MAX_NESTING + 1)}${remove}${")".repeat(MAX_NESTING + 1)}`,
    `${remove} "$(`.repeat(50_000),
    "$(".repeat(20_000),
  ]) {
    const { scan, seconds } = timed(command);
    assert.ok(seconds < 1, `${seconds}s`);
    assert.equal(scan.offending, undefined);
    assert.match(scan.skipped ?? "", /longer than|nests deeper/u);
  }
  const nested = `${"$(".repeat(MAX_NESTING - 2)}${remove}${")".repeat(MAX_NESTING - 2)}`;
  assert.equal(scanDeletes(nested).offending, remove);
  const result = bashGuard(
    JSON.stringify({
      session_id: "s",
      cwd: "/nonexistent",
      tool_name: "Bash",
      tool_input: { command: "$(".repeat(1_000) },
    }),
    "claude",
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, undefined);
  assert.match(
    result.stderr ?? "",
    /the delete guard did not scan this command because it nests deeper than 64 levels; it runs unchecked/u,
  );
});
