import { TabDef, aud, en, fx, id, inp } from './dsl';

/** Config + master data tabs. */
export const CORE_TABS: TabDef[] = [
  {
    name: 'SYSTEM_CONFIG', group: 'System', protection: 'SERVICE_ONLY', capacity: 200, keyColumn: 'key', cacheable: true,
    purpose: 'Global settings, day boundary, night window, active period, Drive folder IDs, feature flags and partition strategy.',
    columns: [id('key'), inp('value', 'text'), inp('type'), inp('description'), inp('updated_at', 'datetime'), inp('updated_by')],
  },
  {
    name: 'USERS', group: 'Security', protection: 'SERVICE_ONLY', capacity: 1000, keyColumn: 'user_id',
    purpose: 'Login identity, role, employee link, branch scope and MFA-ready fields. password_hash is scrypt; never a plaintext password.',
    columns: [
      id('user_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), inp('email', 'text', { required: true }), inp('display_name'),
      inp('password_hash'), en('role', 'ROLE', { required: true }), inp('location_scope', 'text', { note: 'ALL or comma separated location_id list' }),
      en('mfa_enabled', 'YN'), inp('mfa_secret_ref'), inp('failed_attempts', 'number'), inp('locked_until', 'datetime'),
      inp('last_login_at', 'datetime'), inp('password_changed_at', 'datetime'), en('must_change_password', 'YN', { note: 'Y = the person must choose a new password at the next sign-in' }), ...aud('USER_STATUS'),
    ],
  },
  {
    name: 'ROLES', group: 'Security', protection: 'SERVICE_ONLY', capacity: 400, keyColumn: 'role_id', cacheable: true,
    purpose: 'Permission matrix. The API enforces exactly what this tab says (deny by default).',
    columns: [
      id('role_id'), en('role', 'ROLE', { required: true }), inp('resource', 'text', { required: true }),
      en('can_read', 'YN'), en('can_write', 'YN'), en('can_approve', 'YN'), en('can_export', 'YN'),
      inp('scope', 'text', { note: 'ALL | BRANCH | TEAM | SELF' }), inp('description'),
    ],
  },
  {
    name: 'EMPLOYEES', group: 'HR', protection: 'FORMULA_ONLY', capacity: 1500, keyColumn: 'employee_id',
    purpose: 'Employee master. weekly_off_pattern is a list of day codes (e.g. SAT,SUN); weekend_mask is derived.',
    columns: [
      id('employee_id'), inp('employee_code', 'text', { required: true }), inp('first_name', 'text', { required: true }), inp('last_name'),
      inp('email'), inp('phone'), inp('date_of_joining', 'date', { required: true }), inp('date_of_exit', 'date'),
      en('employment_type', 'EMPLOYMENT_TYPE'), en('employee_status', 'EMPLOYEE_STATUS'),
      id('department_id', { ref: 'DEPARTMENTS.department_id', required: false }), id('designation_id', { ref: 'DESIGNATIONS.designation_id', required: false }),
      id('location_id', { ref: 'LOCATIONS.location_id', required: false }), id('manager_employee_id', { required: false }),
      id('default_shift_id', { ref: 'SHIFT_MASTER.shift_id', required: false }),
      inp('weekly_off_pattern', 'text', { note: 'Day codes: MON,TUE,WED,THU,FRI,SAT,SUN' }),
      inp('probation_end_date', 'date'), en('ot_eligible', 'YN'), en('pf_applicable', 'YN'), en('esi_applicable', 'YN'), en('pt_applicable', 'YN'),
      inp('cost_center_id'), inp('bank_account_ref', 'text', { note: 'masked reference only, e.g. ****1234' }), inp('bank_ifsc'),
      ...aud('RECORD_STATUS'),
      fx('weekend_mask', 'IF(@employee_id="","",IF(ISNUMBER(SEARCH("MON",@weekly_off_pattern)),"1","0")&IF(ISNUMBER(SEARCH("TUE",@weekly_off_pattern)),"1","0")&IF(ISNUMBER(SEARCH("WED",@weekly_off_pattern)),"1","0")&IF(ISNUMBER(SEARCH("THU",@weekly_off_pattern)),"1","0")&IF(ISNUMBER(SEARCH("FRI",@weekly_off_pattern)),"1","0")&IF(ISNUMBER(SEARCH("SAT",@weekly_off_pattern)),"1","0")&IF(ISNUMBER(SEARCH("SUN",@weekly_off_pattern)),"1","0"))', 'text'),
      fx('full_name', 'IF(@employee_id="","",TRIM(@first_name&" "&@last_name))', 'text'),
      fx('dup_code_check', 'IF(@employee_id="","",IF(COUNTIFS([EMPLOYEES.employee_code],@employee_code)>1,"DUPLICATE_CODE","OK"))', 'text'),
    ],
  },
  {
    name: 'EMPLOYMENT_HISTORY', group: 'HR', protection: 'SERVICE_ONLY', appendOnly: true, capacity: 5000, keyColumn: 'event_id',
    purpose: 'Joining, transfer, promotion, confirmation, salary revision, resignation, exit and rehire events.',
    columns: [
      id('event_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), en('event_type', 'EMPLOYMENT_EVENT', { required: true }),
      inp('effective_date', 'date', { required: true }), inp('from_value'), inp('to_value'), inp('reason'), ...aud('RECORD_STATUS'),
    ],
  },
  {
    name: 'EMPLOYEE_DOCUMENTS', group: 'HR', protection: 'FORMULA_ONLY', capacity: 8000, keyColumn: 'document_id',
    purpose: 'Employee document metadata. The binary lives in a restricted Drive folder; only the Drive file id and checksum are stored here.',
    columns: [
      id('document_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), inp('doc_type', 'text', { required: true }), inp('file_name', 'text', { required: true }), inp('mime_type'),
      inp('size_bytes', 'number'), inp('drive_file_id'), inp('checksum'), en('visibility', 'DOC_VISIBILITY'), inp('uploaded_by'), inp('uploaded_at', 'datetime'), ...aud('RECORD_STATUS'),
    ],
  },
  {
    name: 'DEPARTMENTS', group: 'HR', protection: 'FORMULA_ONLY', capacity: 300, keyColumn: 'department_id',
    purpose: 'Department master.',
    columns: [id('department_id'), inp('code'), inp('name', 'text', { required: true }), inp('head_employee_id'), inp('cost_center_id'), inp('parent_department_id'), ...aud()],
  },
  {
    name: 'DESIGNATIONS', group: 'HR', protection: 'FORMULA_ONLY', capacity: 300, keyColumn: 'designation_id',
    purpose: 'Designation and grade master.',
    columns: [id('designation_id'), inp('name', 'text', { required: true }), inp('grade'), inp('level', 'number'), ...aud()],
  },
  {
    name: 'LOCATIONS', group: 'HR', protection: 'FORMULA_ONLY', capacity: 200, keyColumn: 'location_id',
    purpose: 'Branch / site with timezone and geofence settings.',
    columns: [
      id('location_id'), inp('name', 'text', { required: true }), inp('address'), inp('city'), inp('state'), inp('timezone', 'text', { required: true }),
      inp('latitude', 'number'), inp('longitude', 'number'), inp('geofence_radius_m', 'number'), en('geofence_required', 'YN'), ...aud(),
    ],
  },
  {
    name: 'SHIFT_MASTER', group: 'Attendance', protection: 'FORMULA_ONLY', capacity: 200, keyColumn: 'shift_id', cacheable: true,
    purpose: 'Shift definitions. start_time/end_time are time-of-day; end <= start means the shift crosses midnight.',
    columns: [
      id('shift_id'), inp('shift_name', 'text', { required: true }), en('shift_type', 'SHIFT_TYPE'), inp('start_time', 'time'), inp('end_time', 'time'),
      inp('break_minutes', 'number'), inp('grace_in_minutes', 'number'), inp('grace_out_minutes', 'number'),
      inp('full_day_minutes', 'number', { required: true }), inp('half_day_minutes', 'number', { required: true }),
      inp('ot_threshold_minutes', 'number'), en('is_flexible', 'YN'), inp('effective_from', 'date'), inp('effective_to', 'date'), ...aud(),
    ],
  },
  {
    name: 'SHIFT_ROSTER', group: 'Attendance', protection: 'FORMULA_ONLY', capacity: 20000, keyColumn: 'roster_id',
    purpose: 'Date-wise shift assignment. A roster row overrides the employee default shift and weekly off pattern.',
    columns: [
      id('roster_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), inp('work_date', 'date', { required: true }),
      id('shift_id', { ref: 'SHIFT_MASTER.shift_id', required: false }), en('is_week_off', 'YN'), ...aud(),
      fx('roster_key', 'IF(@roster_id="","",@employee_id&":"&@work_date)', 'text'),
      fx('dup_check', 'IF(@roster_id="","",IF(COUNTIFS([SHIFT_ROSTER.roster_key],@roster_key)>1,"DUPLICATE","OK"))', 'text'),
    ],
  },
  {
    name: 'HOLIDAYS', group: 'Attendance', protection: 'FORMULA_ONLY', capacity: 500, keyColumn: 'holiday_id',
    purpose: 'Holiday calendar. location_id = ALL applies company wide.',
    columns: [
      id('holiday_id'), inp('holiday_date', 'date', { required: true }), inp('name', 'text', { required: true }), en('holiday_type', 'HOLIDAY_TYPE'),
      inp('location_id', 'text', { note: 'ALL or a location_id' }), ...aud('RECORD_STATUS'),
      fx('effective_date', 'IF(@holiday_id="",1,IF(@status="ACTIVE",@holiday_date,1))', 'date', { note: 'serial 1 (1899) = inactive/blank; keeps NETWORKDAYS holiday range numeric' }),
    ],
  },
  {
    name: 'LOOKUPS', group: 'System', protection: 'SERVICE_ONLY', capacity: 60, keyColumn: 'RECORD_STATUS',
    purpose: 'Controlled dropdown lists. One column per list; header is the list name.',
    columns: [], // generated from ENUMS in build.ts
  },
];

export { aud };
