#!/usr/bin/env bash
# All deployment tests. Needs Docker and network access (base images, Cloudflare IP list).
#   usage: deploy/test/run-all.sh [shellcheck|nginx|setup|tunnel|backup|compose|deploy ...]
set -euo pipefail
cd "$(dirname "$0")/.."

ALL=(shellcheck nginx setup tunnel backup compose deploy)
TESTS=("${@:-${ALL[@]}}")
[[ $# -gt 0 ]] || TESTS=("${ALL[@]}")

for t in "${TESTS[@]}"; do
  printf '\n\033[1;35m### %s\033[0m\n' "$t"
  case $t in
    shellcheck)
      mapfile -t scripts < <(find . -name '*.sh' | sort)
      docker run --rm -v "$PWD:/mnt:ro" -w /mnt koalaman/shellcheck:stable -x -P SCRIPTDIR -S warning "${scripts[@]}"
      docker run --rm -v "$PWD:/mnt:ro" -w /mnt koalaman/shellcheck:stable -x -P SCRIPTDIR deploy.sh droplet/*.sh pc/*.sh
      echo "shellcheck clean (${#scripts[@]} scripts)"
      ;;
    nginx|setup|tunnel|backup|compose|deploy) "./test/test-$t.sh" ;;
    *) echo "unknown test: $t" >&2; exit 2 ;;
  esac
done
printf '\n\033[1;32mAll deploy tests passed: %s\033[0m\n' "${TESTS[*]}"
