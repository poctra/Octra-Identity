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
    ok: /payable\s+fn\s+buy_name\s*\(\s*label:\s*string,\s*new_destination:\s*string\s*\)/.test(source),
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
