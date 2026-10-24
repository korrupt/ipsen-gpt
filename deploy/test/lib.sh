# Shared helpers for deploy tests (sourced).
# shellcheck shell=bash disable=SC2034
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deploy"
PASS=0

pass() { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# assert_eq <actual> <expected> <description>
assert_eq() { [[ "$1" == "$2" ]] && pass "$3" || fail "$3: expected '$2', got '$1'"; }
# assert_contains <haystack> <needle> <description>
assert_contains() { [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3: '$2' not in: ${1:0:400}"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] && pass "$3" || fail "$3: unexpected '$2' in: ${1:0:400}"; }

# wait_for <seconds> <command...>
wait_for() {
  local secs=$1; shift
  for _ in $(seq 1 $((secs * 4))); do "$@" >/dev/null 2>&1 && return 0; sleep 0.25; done
  return 1
}

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
