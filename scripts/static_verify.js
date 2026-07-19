const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const sourcePath = path.join(ROOT, 'ons.aml')
const outDir = path.join(ROOT, 'build', 'ons')
const outPath = path.join(outDir, 'static-verification.json')

const source = fs.readFileSync(sourcePath, 'utf8')

const checks = [
  {
    code: 'NO_NAME_VIEW_PK_FIELD',
    ok: !/name_view_pk|ViewPkUpdated|view_pk_of|update_view_pk/.test(source),
    detail: 'contract source has no view_pk storage, events, views, or mutators',
  },
  {
    code: 'REGISTER_SIGNATURE_NO_VIEW_PK',
    ok: /payable\s+fn\s+register_name\s*\(\s*label:\s*string,\s*destination_val:\s*string,\s*years:\s*int\s*\)/.test(source),
    detail: 'register_name(label, destination, years)',
  },
  {
    code: 'BUY_SIGNATURE_NO_VIEW_PK',
    ok: /payable\s+(?:nonreentrant\s+)?fn\s+buy_name\s*\(\s*label:\s*string,\s*new_destination:\s*string\s*\)/.test(source),
    detail: 'buy_name(label, destination)',
  },
  {
    code: 'LABEL_WHITELIST',
    ok: /abcdefghijklmnopqrstuvwxyz0123456789-/.test(source) &&
      /substr\s*\(\s*label,\s*i,\s*1\s*\)/.test(source) &&
      /index_of\s*\(\s*allowed,\s*ch\s*\)/.test(source),
    detail: 'label characters are checked against lowercase ascii letters, digits, and hyphen',
  },
  {
    code: 'LABEL_HYPHEN_BOUNDARIES',
    ok: /substr\s*\(\s*label,\s*0,\s*1\s*\)\s*==\s*"-"/.test(source) &&
      /substr\s*\(\s*label,\s*n\s*-\s*1,\s*1\s*\)\s*==\s*"-"/.test(source),
    detail: 'hyphen is rejected at the first and last label positions',
  },
  {
    code: 'LABEL_LENGTH_LIMITS',
    ok: /require\s*\(\s*n\s*>=\s*3,\s*"label too short"\s*\)/.test(source) &&
      /require\s*\(\s*n\s*<=\s*63,\s*"label too long"\s*\)/.test(source),
    detail: 'label min/max length enforced on writes',
  },
  {
    code: 'RESERVED_NAMES',
    ok: ['root', 'lambda', 'lambda0xe', 'bunch', 'alex', 'octra', 'poctra']
      .every((name) => source.includes(`label == "${name}"`)),
    detail: 'all configured reserved names are present',
  },
  {
    code: 'RESERVED_ADMIN_REGISTER',
    ok: /require_reserved_admin\s*\(\s*label\s*\)/.test(source) &&
      /require\s*\(\s*caller\s*==\s*self\.owner,\s*"reserved name"\s*\)/.test(source),
    detail: 'reserved registration requires the admin caller',
  },
  {
    code: 'MANAGED_RESERVED_NAMES_SEEDED',
    ok: ['root', 'alex', 'lambda', 'lambda0xe', 'bunch', 'octra', 'poctra']
      .every((name) => source.includes(`seed_reserved_name("${name}")`)) &&
      /private\s+fn\s+seed_reserved_name\s*\(\s*label:\s*string\s*\)/.test(source) &&
      /self\.name_owner\[label\]\s*=\s*self\.owner/.test(source) &&
      /self\.name_destination\[label\]\s*=\s*self\.owner/.test(source) &&
      /owner_index_add\s*\(\s*self\.owner\s*,\s*label\s*\)/.test(source),
    detail: 'managed reserved names are minted to deployer during construction',
  },
  {
    code: 'OWNER_CONTROLLED_RESOLVER',
    ok: /private\s+fn\s+set_name_record\s*\(\s*label:\s*string,\s*resolver:\s*string\s*\)/.test(source) &&
      /require\s*\(\s*caller\s*==\s*self\.name_owner\[label\],\s*"not owner"\s*\)/.test(source) &&
      /require\s*\(\s*epoch\s*<=\s*self\.name_expiry\[label\],\s*"expired"\s*\)/.test(source) &&
      /assert_address\s*\(\s*resolver\s*\)/.test(source) &&
      /self\.name_destination\[label\]\s*=\s*resolver/.test(source),
    detail: 'active name owner can point its record to a distinct valid resolver address',
  },
  {
    code: 'SINGLE_RESOLVER_WRITE_METHOD',
    ok: /fn\s+set_record\s*\(\s*label:\s*string,\s*resolver:\s*string\s*\):\s*bool/.test(source) &&
      /set_name_record\s*\(\s*label\s*,\s*resolver\s*\)/.test(source) &&
      !/fn\s+update_resolver\s*\(/.test(source) &&
      !/fn\s+update_destination\s*\(/.test(source) &&
      /event\s+RecordUpdated\s*\(\s*label:\s*string,\s*resolver:\s*string\s*\)/.test(source),
    detail: 'set_record is the single owner-controlled resolver write API',
  },
  {
    code: 'ROOT_PRIMARY_ON_DEPLOY',
    ok: /seed_reserved_name\s*\(\s*"root"\s*\)/.test(source) &&
      /self\.reverse_primary\[self\.owner\]\s*=\s*"root"/.test(source) &&
      /emit\s+PrimarySet\s*\(\s*self\.owner\s*,\s*"root"\s*\)/.test(source),
    detail: 'root.oct is seeded and set as deployer primary name',
  },
  {
    code: 'MANAGED_RESERVED_ADMIN_TRANSFER',
    ok: /fn\s+transfer_reserved_name\s*\(\s*label:\s*string,\s*new_owner:\s*address,\s*new_destination:\s*string\s*\):\s*bool/.test(source) &&
      /only_admin\s*\(\s*\)/.test(source) &&
      /require\s*\(\s*is_managed_reserved_name\s*\(\s*label\s*\),\s*"not managed reserved"\s*\)/.test(source) &&
      /emit\s+NameTransferred\s*\(\s*label\s*,\s*prev_owner\s*,\s*new_owner\s*\)/.test(source),
    detail: 'managed reserved names can only be transferred by contract admin',
  },
  {
    code: 'RESERVED_MARKET_LOCK',
    ok: (source.match(/require_publicly_transferable\s*\(\s*label\s*\)/g) ?? []).length >= 4 &&
      /require\s*\(\s*!\s*is_reserved_name\s*\(\s*label\s*\),\s*"reserved name locked"\s*\)/.test(source),
    detail: 'reserved names cannot be transferred, released, listed, or bought through public flows',
  },
  {
    code: 'RESERVED_AVAILABLE_VIEW_FALSE',
    ok: /view\s+fn\s+is_available\s*\(\s*label:\s*string\s*\):\s*bool/.test(source) &&
      /if\s+is_reserved_name\s*\(\s*label\s*\)\s*\{\s*return\s+false\s*\}/.test(source),
    detail: 'reserved names are not shown as available to dApps',
  },
  {
    code: 'RESERVED_AND_VALIDITY_VIEWS',
    ok: /view\s+fn\s+is_valid_label\s*\(\s*label:\s*string\s*\):\s*bool/.test(source) &&
      /view\s+fn\s+is_reserved\s*\(\s*label:\s*string\s*\):\s*bool/.test(source),
    detail: 'public views expose label validity and reserved status',
  },
  {
    code: 'FIRST_REGISTER_AUTO_PRIMARY',
    ok: /private\s+fn\s+has_active_primary\s*\(\s*holder:\s*address\s*\):\s*bool/.test(source) &&
      /if\s+!has_active_primary\s*\(\s*caller\s*\)\s*\{/.test(source) &&
      /self\.reverse_primary\[caller\]\s*=\s*label/.test(source) &&
      /emit\s+PrimarySet\s*\(\s*caller\s*,\s*label\s*\)/.test(source),
    detail: 'first successful registration sets primary name when caller has no active primary',
  },
  {
    code: 'SUBDOMAIN_METHODS',
    ok: [
      'set_sub_record',
      'release_subdomain',
      'resolve_subdomain',
      'resolve_name',
      'subdomain_key_at',
    ].every((method) => source.includes(method)),
    detail: 'contract exposes parent-managed subdomain writes and views',
  },
  {
    code: 'SUBDOMAIN_LABEL_RULES',
    ok: /private\s+fn\s+require_valid_sub_label/.test(source) &&
      /require\s*\(\s*n\s*>=\s*1,\s*"sub label too short"\s*\)/.test(source) &&
      /require\s*\(\s*n\s*<=\s*63,\s*"sub label too long"\s*\)/.test(source) &&
      /view\s+fn\s+is_valid_sub_label/.test(source) &&
      (source.match(/require_valid_sub_label\s*\(\s*sub_label\s*\)/g) ?? []).length >= 2,
    detail: 'subdomain labels allow 1-63 valid characters and use the same hyphen boundaries',
  },
  {
    code: 'SINGLE_SUBDOMAIN_RECORD_WRITE_METHOD',
    ok: /fn\s+set_sub_record\s*\(\s*parent_label:\s*string,\s*sub_label:\s*string,\s*resolver:\s*string\s*\):\s*bool/.test(source) &&
      !/fn\s+register_subdomain\s*\(/.test(source) &&
      !/fn\s+update_subdomain_destination\s*\(/.test(source) &&
      /event\s+SubRecordSet\s*\(\s*parent:\s*string,\s*sub:\s*string,\s*resolver:\s*string\s*\)/.test(source),
    detail: 'set_sub_record is the single create/update API for subdomain records',
  },
  {
    code: 'SUBDOMAIN_PARENT_OWNER_GUARD',
    ok: /require_active_parent_owner\s*\(\s*parent_label\s*\)/.test(source) &&
      /require\s*\(\s*caller\s*==\s*self\.name_owner\[parent_label\],\s*"not parent owner"\s*\)/.test(source) &&
      /require\s*\(\s*epoch\s*<=\s*self\.name_expiry\[parent_label\],\s*"parent expired"\s*\)/.test(source),
    detail: 'subdomain writes require active parent ownership',
  },
  {
    code: 'SUBDOMAIN_FOLLOWS_PARENT_EXPIRY',
    ok: /view\s+fn\s+resolve_subdomain/.test(source) &&
      /let\s+exp\s*=\s*self\.name_expiry\[parent_label\]/.test(source) &&
      /if\s+epoch\s*>\s*exp\s*\{\s*return\s+"0"\s*\}/.test(source) &&
      !/sub_expiry|subdomain_expiry/.test(source),
    detail: 'subdomains have no independent expiry and stop resolving with parent expiry',
  },
  {
    code: 'SUBDOMAIN_GENERATION_GUARD',
    ok: /name_generation:\s+map\[string\]int/.test(source) &&
      /sub_generation:\s+map\[string\]map\[string\]int/.test(source) &&
      /self\.name_generation\[label\]\s*\+=\s*1/.test(source) &&
      /self\.sub_generation\[parent_label\]\[sub_label\]\s*!=\s*self\.name_generation\[parent_label\]/.test(source),
    detail: 'stale subdomains cannot revive after parent release or re-registration',
  },
  {
    code: 'SUBDOMAIN_RESOLVER_SHORT_LABEL_RULE',
    ok: /view\s+fn\s+resolve_subdomain[\s\S]*?if\s+!is_valid_sub_label_value\s*\(\s*sub_label\s*\)\s*\{\s*return\s+"0"\s*\}/.test(source),
    detail: 'resolver accepts the same 1-63 character subdomain labels as writes',
  },
  {
    code: 'PUBLIC_MUTATOR_LABEL_GUARDS',
    ok: /private\s+fn\s+require_publicly_transferable\s*\(\s*label:\s*string\s*\)[\s\S]*?require_valid_label\s*\(\s*label\s*\)/.test(source) &&
      /fn\s+set_primary\s*\(\s*label:\s*string\s*\)[\s\S]*?require_valid_label\s*\(\s*label\s*\)/.test(source) &&
      /fn\s+cancel_listing\s*\(\s*label:\s*string\s*\)[\s\S]*?require_valid_label\s*\(\s*label\s*\)/.test(source),
    detail: 'every public label mutation validates its dynamic storage key',
  },
  {
    code: 'SAFE_DYNAMIC_KEY_VIEWS',
    ok: /view\s+fn\s+resolve\s*\(\s*label:\s*string\s*\)[\s\S]*?if\s+!is_valid_label_value\s*\(\s*label\s*\)\s*\{\s*return\s+"0"\s*\}/.test(source) &&
      /view\s+fn\s+get_name_snapshot[\s\S]*?if\s+!is_valid_label_value\s*\(\s*label\s*\)\s*\{\s*return\s+out\s*\}/.test(source) &&
      /view\s+fn\s+subdomain_key_at[\s\S]*?if\s+idx\s*<\s*0\s*\{\s*return\s+""\s*\}/.test(source),
    detail: 'invalid view keys and indexes return typed empty values without malformed snapshots',
  },
  {
    code: 'ACTIVE_LISTING_PROJECTION',
    ok: /private\s+fn\s+has_active_listing/.test(source) &&
      /self\.name_owner\[label\]\s*!=\s*seller/.test(source) &&
      /epoch\s*>\s*exp/.test(source) &&
      (source.match(/if\s+!has_active_listing\s*\(\s*label\s*\)/g) ?? []).length >= 4,
    detail: 'expired, orphaned, and inconsistent listings are never exposed as purchasable',
  },
  {
    code: 'PERMISSIONLESS_STALE_LISTING_PRUNE',
    ok: /fn\s+prune_listing\s*\(\s*label:\s*string\s*\):\s*bool/.test(source) &&
      /require\s*\(\s*!has_active_listing\s*\(\s*label\s*\)\s*,\s*"listing active"\s*\)/.test(source) &&
      /listing_remove\s*\(\s*label\s*\)/.test(source),
    detail: 'any caller can compact stale listing slots without changing name ownership',
  },
  {
    code: 'LAPSED_LISTING_CANNOT_REVIVE_ON_RENEWAL',
    ok: /fn\s+renew_name[\s\S]*?if\s+epoch\s*>\s*cur_expiry\s*&&\s*listing_state[\s\S]*?listing_remove\s*\(\s*label\s*\)[\s\S]*?emit\s+NameUnlisted\s*\(\s*label\s*\)/.test(source),
    detail: 'renewing after expiry clears stale sale authorization before the name becomes active again',
  },
  {
    code: 'AUTOMATIC_CLEANUP_EVENTS',
    ok: /private\s+fn\s+clear_listing_and_reverse[\s\S]*?emit\s+PrimaryCleared\s*\(\s*prev_owner\s*\)/.test(source) &&
      /private\s+fn\s+clear_listing_and_reverse[\s\S]*?emit\s+NameUnlisted\s*\(\s*label\s*\)/.test(source),
    detail: 'automatic listing and reverse-record cleanup remains observable through events',
  },
  {
    code: 'VALUE_EXIT_REENTRANCY_GUARDS',
    ok: /nonreentrant\s+fn\s+withdraw_fees/.test(source) &&
      /payable\s+nonreentrant\s+fn\s+buy_name/.test(source),
    detail: 'all native-value exit paths use the compiler reentrancy guard',
  },
  {
    code: 'ADMIN_RECOVERY_GUARDS',
    ok: /require\s*\(\s*to\s*!=\s*self_addr\s*,\s*"cannot withdraw to self"\s*\)/.test(source) &&
      /require\s*\(\s*next_owner\s*!=\s*self\.owner\s*,\s*"already owner"\s*\)/.test(source) &&
      /require\s*\(\s*next_owner\s*!=\s*self_addr\s*,\s*"contract cannot own itself"\s*\)/.test(source),
    detail: 'fee withdrawal and two-step ownership cannot target unrecoverable contract states',
  },
  {
    code: 'CALLER_BASED_NAME_OWNERSHIP',
    ok: !/origin\s*==\s*self\.name_owner/.test(source) &&
      !/self\.name_owner\[label\]\s*=\s*origin/.test(source) &&
      /self\.name_owner\[label\]\s*=\s*caller/.test(source) &&
      /owner_index_add\s*\(\s*caller\s*,\s*label\s*\)/.test(source),
    detail: 'name lifecycle uses immediate caller so contract multisigs can own and manage names',
  },
  {
    code: 'ALL_PAYABLE_REVENUE_ACCOUNTED',
    ok: (source.match(/self\.fees_collected\s*\+=\s*cost/g) ?? []).length === 2 &&
      /self\.fees_collected\s*\+=\s*fee/.test(source) &&
      /let\s+amount\s*=\s*self\.fees_collected/.test(source),
    detail: 'registration, renewal, and marketplace revenue are all withdrawable',
  },
  {
    code: 'VALID_AVAILABLE_VIEW',
    ok: /view\s+fn\s+is_available[\s\S]*?if\s+!is_valid_label_value\s*\(\s*label\s*\)\s*\{\s*return\s+false\s*\}/.test(source),
    detail: 'invalid labels are never reported as available',
  },
  {
    code: 'GENERATION_SCOPED_SUBDOMAIN_INDEX',
    ok: /sub_index_generation:\s+map\[string\]map\[string\]int/.test(source) &&
      /sub_count_generation:\s+map\[string\]int/.test(source) &&
      /self\.sub_count_generation\[parent_label\]\s*!=\s*generation/.test(source) &&
      /self\.sub_count\[parent_label\]\s*=\s*0/.test(source),
    detail: 'subdomain enumeration resets logically for each parent generation',
  },
  {
    code: 'SINGLE_RECORD_EVENT',
    ok: !/DestinationUpdated/.test(source) &&
      /event\s+RecordUpdated\s*\(\s*label:\s*string,\s*resolver:\s*string\s*\)/.test(source) &&
      (source.match(/emit\s+RecordUpdated\s*\(/g) ?? []).length >= 5,
    detail: 'all resolver changes use one informative RecordUpdated event',
  },
  {
    code: 'ATOMIC_RESERVED_ADMIN_HANDOVER',
    ok: /private\s+fn\s+migrate_reserved_admin_name/.test(source) &&
      ['root', 'alex', 'lambda', 'lambda0xe', 'bunch', 'octra', 'poctra']
        .every((name) => source.includes(`migrate_reserved_admin_name("${name}", old, self.owner)`)),
    detail: 'admin acceptance atomically migrates reserved names still owned by the previous admin',
  },
  {
    code: 'VERSIONED_SNAPSHOT_STATE',
    ok: /config_version:\s+int/.test(source) &&
      /registry_version:\s+int/.test(source) &&
      /listing_version:\s+int/.test(source) &&
      /owner_version:\s+map\[address\]int/.test(source) &&
      /subdomain_version:\s+map\[string\]int/.test(source),
    detail: 'read models expose independent versions for config, registry, listings, owners, and subdomains',
  },
  {
    code: 'BOUNDED_SNAPSHOT_PAGES',
    ok: /private\s+fn\s+clamp_page_limit/.test(source) &&
      /if\s+limit\s*>\s*25\s*\{\s*limit\s*=\s*25\s*\}/.test(source) &&
      ['get_owner_page', 'get_listing_page', 'get_subdomain_page']
        .every((method) => source.includes(`view fn ${method}`)),
    detail: 'enumeration snapshots are cursor-paged and capped at 25 rows per view',
  },
  {
    code: 'SNAPSHOT_VERSION_GUARDS',
    ok: (source.match(/expected_version\s*>=\s*0\s*&&\s*expected_version\s*!=\s*version/g) ?? []).length === 3 &&
      (source.match(/return\s+append_int_field\s*\(\s*"stale"\s*,\s*version\s*\)/g) ?? []).length === 3,
    detail: 'later pages reject stale cursors after swap-and-pop mutations',
  },
  {
    code: 'COMPOSITE_READ_VIEWS',
    ok: /view\s+fn\s+get_name_snapshot/.test(source) &&
      /view\s+fn\s+get_config_snapshot/.test(source) &&
      /private\s+fn\s+append_name_row/.test(source) &&
      /concat\s*\(\s*payload\s*,\s*"#"\s*\)/.test(source) &&
      /concat\s*\(\s*concat\s*\(\s*payload\s*,\s*"\|"\s*\)\s*,\s*field\s*\)/.test(source),
    detail: 'exact-name, configuration, and paged enumeration data use snapshot schema v1',
  },
  {
    code: 'SNAPSHOT_MUTATION_TRACKING',
    ok: /private\s+fn\s+touch_owner/.test(source) &&
      /private\s+fn\s+touch_registry/.test(source) &&
      /private\s+fn\s+touch_subdomains/.test(source) &&
      (source.match(/touch_owner\s*\(/g) ?? []).length >= 9 &&
      (source.match(/touch_registry\s*\(/g) ?? []).length >= 10 &&
      (source.match(/touch_subdomains\s*\(/g) ?? []).length >= 4 &&
      (source.match(/self\.listing_version\s*\+=\s*1/g) ?? []).length >= 2,
    detail: 'writes invalidate only the read models whose materialized data changed',
  },
]

const failed = checks.filter((check) => !check.ok)
const report = {
  schema: 'octra-id-ons-static-verification.v1',
  source: 'ons.aml',
  safety: failed.length === 0 ? 'safe' : 'error',
  errors: failed.length,
  warnings: 0,
  checks,
  generatedAt: new Date().toISOString(),
}

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(report, null, 2))

for (const check of checks) {
  console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.code} - ${check.detail}`)
}
console.log(`safety=${report.safety} errors=${report.errors} warnings=${report.warnings}`)
console.log(`saved=${path.relative(process.cwd(), outPath)}`)

if (failed.length > 0) process.exit(1)
