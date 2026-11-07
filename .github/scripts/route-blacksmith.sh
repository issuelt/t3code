#!/usr/bin/env bash
# Writes blacksmith_linux, blacksmith_android, and blacksmith_windows to
# GITHUB_OUTPUT. Each holds the job's Blacksmith label only when the event is
# trusted, BLACKSMITH_ROUTING is not off, the label variable is valid, and this
# month's tally leaves room for one more hour of that job:
#   used + 600 (other repositories) + 60 * factor <= 2400.
# Every other case, including any failed call or missing data, writes an empty
# value so the job keeps its VM104 or hosted runner. This never reads VM104.
#
# Inputs: TRUSTED, BLACKSMITH_ROUTING, BLACKSMITH_LINUX_LABEL,
# BLACKSMITH_ANDROID_LABEL, BLACKSMITH_WINDOWS_LABEL, GH_TOKEN (actions: read),
# GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_OUTPUT. Tests set ROUTE_NOW
# (epoch seconds) to fix the clock.
set -uo pipefail

budget=2400
others=600
max_age=$((3 * 3600))
label_pattern='^blacksmith-[0-9]+vcpu-(ubuntu-2404|windows-2025)$'
api="${GITHUB_API_URL:-https://api.github.com}"
kinds=(linux android windows)
declare -A labels=()

finish() {
	local kind
	for kind in "${kinds[@]}"; do
		echo "blacksmith_$kind=${labels[$kind]:-}" >>"$GITHUB_OUTPUT"
		if [[ -n "${labels[$kind]:-}" ]]; then echo "Blacksmith $kind: ${labels[$kind]}."; fi
	done
	exit 0
}

deny() {
	echo "Blacksmith: none ($1)."
	labels=()
	finish
}

call() {
	curl -fsS --connect-timeout 5 --max-time 30 \
		-H @<(printf 'Authorization: Bearer %s\n' "$GH_TOKEN") \
		-H "Accept: application/vnd.github+json" \
		-H "X-GitHub-Api-Version: 2022-11-28" \
		"$@"
}

for kind in linux android windows; do
	var="BLACKSMITH_${kind^^}_LABEL"
	value="${!var:-}"
	if [[ -z "$value" ]]; then
		echo "Blacksmith $kind: none ($var is empty)."
	elif [[ "$value" =~ $label_pattern ]]; then
		labels[$kind]="$value"
	else
		echo "Blacksmith $kind: none ($var is not a supported label)."
	fi
done

[[ "${TRUSTED:-}" == true ]] || deny "untrusted event"
[[ "${BLACKSMITH_ROUTING:-}" != off ]] || deny "BLACKSMITH_ROUTING is off"
((${#labels[@]} > 0)) || deny "no valid label"
[[ -n "${GH_TOKEN:-}" ]] || deny "no GITHUB_TOKEN"

now="${ROUTE_NOW:-$(date +%s)}"
month="$(date -u -d "@$now" +%Y-%m)"
work="$(mktemp -d)" || deny "no temporary directory"
trap 'rm -rf "$work"' EXIT

run="$(call "$api/repos/$GITHUB_REPOSITORY/actions/workflows/blacksmith-usage.yml/runs?branch=main&status=success&per_page=1" |
	jq -er '.workflow_runs[0] | select(.head_branch == "main" and (.event == "schedule" or .event == "workflow_dispatch")) | .id' 2>/dev/null)" ||
	deny "no successful blacksmith-usage run on main"
[[ "$run" =~ ^[0-9]+$ ]] || deny "no successful blacksmith-usage run on main"

artifact="$(call "$api/repos/$GITHUB_REPOSITORY/actions/runs/$run/artifacts?name=blacksmith-usage" |
	jq -er '[.artifacts[] | select(.name == "blacksmith-usage" and .expired == false)][0].id' 2>/dev/null)" ||
	deny "run $run has no blacksmith-usage artifact"
[[ "$artifact" =~ ^[0-9]+$ ]] || deny "run $run has no blacksmith-usage artifact"

# The zip endpoint redirects to blob storage; curl drops the Authorization header on the other host.
call -L "$api/repos/$GITHUB_REPOSITORY/actions/artifacts/$artifact/zip" >"$work/usage.zip" ||
	deny "could not download artifact $artifact"
unzip -p "$work/usage.zip" blacksmith-usage.json >"$work/usage.json" 2>/dev/null ||
	deny "artifact $artifact has no blacksmith-usage.json"

# Prints one "kind label" line for each kind that fits, or fails on any data problem.
fits="$(jq -er --arg month "$month" --argjson now "$now" --argjson max_age "$max_age" \
	--argjson budget "$budget" --argjson others "$others" \
	--arg linux "${labels[linux]:-}" --arg android "${labels[android]:-}" --arg windows "${labels[windows]:-}" '
	def factor: capture("^blacksmith-(?<v>[0-9]+)vcpu-(?<os>[a-z]+)-") | (.v | tonumber) / 2 * (if .os == "windows" then 2 else 1 end);
	if .complete != true then error("the tally is incomplete")
	elif .month != $month then error("the tally is for \(.month), not \($month)")
	elif (.used | type) != "number" or .used < 0 then error("the tally has no usage")
	else (.computed_at | fromdateiso8601) as $at
	| if $now - $at > $max_age or $at - $now > 300 then error("the tally from \(.computed_at) is stale")
	  else .used as $used
	  | "used \($used)",
	    ({linux: $linux, android: $android, windows: $windows} | to_entries[]
	      | select(.value != "") | (.value | factor) as $f
	      | select($f > 0 and $used + $others + 60 * $f <= $budget) | "\(.key) \(.value)")
	  end
	end' "$work/usage.json" 2>&1)" || deny "${fits#jq: error (at *): }"

echo "Blacksmith: ${fits%%$'\n'*} of $budget 2-vCPU minutes this month, $others kept for other repositories."
declare -A allowed=()
while read -r kind label; do
	[[ "$kind" == used ]] && continue
	allowed[$kind]="$label"
done <<<"$fits"
for kind in "${kinds[@]}"; do
	if [[ -n "${labels[$kind]:-}" && -z "${allowed[$kind]:-}" ]]; then
		echo "Blacksmith $kind: none (one more hour of ${labels[$kind]} would pass the budget)."
	fi
done
labels=()
for kind in "${!allowed[@]}"; do labels[$kind]="${allowed[$kind]}"; done
finish
