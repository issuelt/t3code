#!/usr/bin/env bash
# Writes vm104=true to GITHUB_OUTPUT only when the event is trusted, runner
# group 10 has an online idle runner with the VM104 label, and no job in this
# repository is queued for that label. Every other case, including any failed
# call, writes vm104=false so the job runs on a hosted runner.
#
# Inputs: TRUSTED, APP_ID, APP_KEY (goat-ci-router), GH_TOKEN (actions: read),
# GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_OUTPUT. Nothing here prints a secret.
set -uo pipefail

org=issuelt
group=10
installation=179653734
label=issuelt-t3code-ubuntu24
api="${GITHUB_API_URL:-https://api.github.com}"

decide() {
	echo "vm104=$1" >>"$GITHUB_OUTPUT"
	if [[ "$1" == true ]]; then echo "Route: VM104 ($2)."; else echo "Route: ubuntu-24.04 ($2)."; fi
	exit 0
}

# Reads the bearer token from a file descriptor so it never appears in argv.
call() {
	local bearer="$1"
	shift
	curl -fsS --connect-timeout 5 --max-time 15 \
		-H @<(printf 'Authorization: Bearer %s\n' "$bearer") \
		-H "Accept: application/vnd.github+json" \
		-H "X-GitHub-Api-Version: 2022-11-28" \
		"$@"
}

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

[[ "${TRUSTED:-}" == true ]] || decide false "untrusted event"
[[ "${APP_ID:-}" =~ ^[A-Za-z0-9.]+$ && -n "${APP_KEY:-}" ]] || decide false "no router App credential"
[[ -n "${GH_TOKEN:-}" ]] || decide false "no GITHUB_TOKEN"

keyfile="$(mktemp)" || decide false "no temporary key file"
token=""
# Delete the key file and revoke the installation token however the script ends.
trap 'rm -f "$keyfile"; [[ -n "$token" ]] && call "$token" -X DELETE "$api/installation/token" >/dev/null 2>&1' EXIT
printf '%s\n' "$APP_KEY" >"$keyfile"
unset APP_KEY

now="$(date +%s)"
header="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)"
payload="$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$APP_ID" | b64url)"
signature="$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$keyfile" -binary 2>/dev/null | b64url)" ||
	decide false "could not sign the App JWT"
[[ -n "$signature" ]] || decide false "could not sign the App JWT"
rm -f "$keyfile"

token="$(call "$header.$payload.$signature" -X POST \
	-d '{"permissions":{"organization_self_hosted_runners":"read"}}' \
	"$api/app/installations/$installation/access_tokens" | jq -er .token 2>/dev/null)" ||
	decide false "could not mint the router installation token"

idle="$(call "$token" "$api/orgs/$org/actions/runner-groups/$group/runners?per_page=100" |
	jq -er --arg label "$label" \
		'if (.total_count // 0) > 100 then error("over one page") else [.runners[] | select(.status == "online" and .busy == false and any(.labels[]; .name == $label))] | length end' 2>/dev/null)" ||
	decide false "could not read runner group $group"
[[ "$idle" =~ ^[0-9]+$ ]] || decide false "could not read runner group $group"
((idle > 0)) || decide false "no online idle runner with label $label"

# Each active run costs one jobs call, so too many runs route hosted before the job's timeout.
checked=0
for status in queued in_progress; do
	runs="$(call "$GH_TOKEN" "$api/repos/$GITHUB_REPOSITORY/actions/runs?status=$status&per_page=100" |
		jq -er 'if (.total_count // 0) > 100 then error("over one page") else [.workflow_runs[].id] | map(tostring) | join(" ") end' 2>/dev/null)" ||
		decide false "could not list $status runs"
	for run in $runs; do
		[[ "$run" =~ ^[0-9]+$ ]] || decide false "could not list $status runs"
		checked=$((checked + 1))
		((checked <= 10)) || decide false "more than 10 active runs to check"
		waiting="$(call "$GH_TOKEN" "$api/repos/$GITHUB_REPOSITORY/actions/runs/$run/jobs?filter=latest&per_page=100" |
			jq -er --arg label "$label" \
				'[.jobs[] | select(.status == "queued" and any(.labels[]; . == $label))] | length' 2>/dev/null)" ||
			decide false "could not list the jobs of run $run"
		[[ "$waiting" =~ ^[0-9]+$ ]] || decide false "could not list the jobs of run $run"
		((waiting == 0)) || decide false "run $run has a job queued for $label"
	done
done

decide true "idle runner and no queued job for $label"
