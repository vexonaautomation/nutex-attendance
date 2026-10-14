import { TabDef, aud, en, fx, id, inp } from './dsl';

const LA = 'LEAVE_APPLICATIONS';
const LB = 'LEAVE_BALANCES';
const LT = 'LEAVE_TRANSACTIONS';

const wLB = (e: string) => `IF(@balance_id="","",${e})`;
const wLA = (e: string) => `IF(@application_id="","",${e})`;
const typ = (col: string, def: string) => `$LKD(LEAVE_TYPES.${col},LEAVE_TYPES.leave_type_id,@leave_type_id,${def})`;

export const LEAVE_TABS: TabDef[] = [
  {
    name: 'LEAVE_TYPES', group: 'Leave', protection: 'FORMULA_ONLY', capacity: 100, keyColumn: 'leave_type_id', cacheable: true,
    purpose: 'Leave types including WFH / OD / travel / comp-off categories that override absence.',
    columns: [
      id('leave_type_id'), inp('code', 'text', { required: true }), inp('name', 'text', { required: true }), en('category', 'LEAVE_CATEGORY', { required: true }),
      en('is_paid', 'YN'), en('requires_approval', 'YN'), en('allow_half_day', 'YN'), en('count_holidays_weekoffs', 'YN', { note: 'Y = holidays / weekly offs inside the range consume balance' }),
      en('allow_negative', 'YN'), inp('max_negative_days', 'number'), inp('min_notice_days', 'number'), inp('max_consecutive_days', 'number'), ...aud(),
    ],
  },
  {
    name: 'LEAVE_POLICIES', group: 'Leave', protection: 'FORMULA_ONLY', capacity: 300, keyColumn: 'policy_id', cacheable: true,
    purpose: 'Eligibility, accrual, pro-rata, carry-forward and encashment rules per leave type and employment type. One ACTIVE row per policy_key.',
    columns: [
      id('policy_id'), id('leave_type_id', { ref: 'LEAVE_TYPES.leave_type_id' }), en('employment_type', 'EMPLOYMENT_TYPE'), inp('annual_quota', 'number', { required: true }),
      inp('accrual_days_per_month', 'number'), en('accrual_method', 'ACCRUAL_METHOD'), en('prorate_joiners', 'YN'), en('probation_lock', 'YN', { note: 'Y = nothing accrues before probation_end_date' }),
      inp('max_carry_forward', 'number'), inp('max_encashable', 'number'), inp('effective_from', 'date'), inp('effective_to', 'date'), ...aud('RECORD_STATUS'),
      fx('policy_key', 'IF(@policy_id="","",IF(@status="ACTIVE",@leave_type_id&":"&@employment_type,"INACTIVE:"&@policy_id))', 'text'),
      fx('dup_check', 'IF(@policy_id="","",IF(COUNTIFS([LEAVE_POLICIES.policy_key],@policy_key)>1,"DUPLICATE_ACTIVE_POLICY","OK"))', 'text'),
    ],
  },
  {
    name: LT, group: 'Leave', protection: 'SERVICE_ONLY', appendOnly: true, capacity: 12000, keyColumn: 'txn_id',
    purpose: 'Leave ledger. Balances change ONLY through rows in this tab. days is signed: credits > 0, debits < 0. Reversals are new rows.',
    columns: [
      id('txn_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), id('leave_type_id', { ref: 'LEAVE_TYPES.leave_type_id' }), inp('leave_year', 'number', { required: true }),
      en('txn_type', 'LEAVE_TXN_TYPE', { required: true }), inp('txn_date', 'date'), inp('days', 'number', { required: true }), inp('reference_id'),
      inp('idempotency_key'), inp('remarks'), ...aud('RECORD_STATUS'),
      fx('balance_key', 'IF(@txn_id="","",@employee_id&":"&@leave_type_id&":"&@leave_year)', 'text'),
      fx('sign_check', 'IF(@txn_id="","",IF(OR(AND(@days>0,OR(@txn_type="OPENING",@txn_type="ACCRUAL",@txn_type="CARRY_FORWARD",@txn_type="COMP_OFF_CREDIT",@txn_type="ADJUSTMENT_CREDIT",@txn_type="LEAVE_REVERSAL")),AND(@days<0,OR(@txn_type="LEAVE_TAKEN",@txn_type="ENCASHMENT",@txn_type="LAPSE",@txn_type="ADJUSTMENT_DEBIT"))),"OK","SIGN_MISMATCH"))', 'text'),
    ],
  },
  {
    name: LA, group: 'Leave', protection: 'FORMULA_ONLY', capacity: 4000, keyColumn: 'application_id',
    purpose: 'Leave / WFH / OD applications and approval state. days_count is formula-derived (holidays and weekly offs excluded unless the type counts them).',
    columns: [
      id('application_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), id('leave_type_id', { ref: 'LEAVE_TYPES.leave_type_id' }),
      inp('from_date', 'date', { required: true }), inp('to_date', 'date', { required: true }), en('half_day', 'YN'), inp('reason'),
      id('approver_employee_id', { required: false }), inp('decided_at', 'datetime'), inp('decided_by'), inp('decision_note'), inp('idempotency_key'),
      ...aud('APPROVAL_STATUS'),
      fx('category', wLA(typ('category', '""')), 'text'),
      fx('is_paid', wLA(typ('is_paid', '"Y"')), 'text'),
      fx('is_leave_like', wLA('IF(OR(@category="LEAVE",@category="COMP_OFF"),"Y","N")'), 'text'),
      fx('is_workday_override', wLA('IF(OR(@category="WFH",@category="OD",@category="TRAVEL"),"Y","N")'), 'text'),
      fx('day_fraction', wLA('IF(@half_day="Y",0.5,1)'), 'number'),
      fx('count_hw', wLA(typ('count_holidays_weekoffs', '"N"')), 'text'),
      fx('weekend_mask', wLA('$LKD(EMPLOYEES.weekend_mask,EMPLOYEES.employee_id,@employee_id,"0000011")'), 'text'),
      fx('days_count', wLA('IF(@half_day="Y",0.5,IF(@count_hw="Y",@to_date-@from_date+1,NETWORKDAYS.INTL(@from_date,@to_date,@weekend_mask,[HOLIDAYS.effective_date])))'), 'number'),
      fx('leave_year', wLA('IF(MONTH(@from_date)>=$CFG(LEAVE_YEAR_START_MONTH),YEAR(@from_date),YEAR(@from_date)-1)'), 'number'),
      fx('balance_key', wLA('@employee_id&":"&@leave_type_id&":"&@leave_year'), 'text'),
      fx('balance_available', wLA('IFERROR(INDEX([LEAVE_BALANCES.available],MATCH(@balance_key,[LEAVE_BALANCES.balance_key],0)),0)+IF(@status="PENDING",@days_count,0)'), 'number',
        { note: 'available balance excluding this application own pending hold' }),
      fx('balance_check', wLA('IF(@is_leave_like<>"Y","N/A",IF(@days_count<=@balance_available,"OK",IF(AND(' + typ('allow_negative', '"N"') + '="Y",@balance_available-@days_count>=-N(' + typ('max_negative_days', '0') + ')),"NEGATIVE_ALLOWED","INSUFFICIENT")))'), 'text'),
      fx('overlap_count', wLA('COUNTIFS([LEAVE_APPLICATIONS.employee_id],@employee_id,[LEAVE_APPLICATIONS.from_date],"<="&@to_date,[LEAVE_APPLICATIONS.to_date],">="&@from_date,[LEAVE_APPLICATIONS.status],"APPROVED")+COUNTIFS([LEAVE_APPLICATIONS.employee_id],@employee_id,[LEAVE_APPLICATIONS.from_date],"<="&@to_date,[LEAVE_APPLICATIONS.to_date],">="&@from_date,[LEAVE_APPLICATIONS.status],"PENDING")-IF(OR(@status="APPROVED",@status="PENDING"),1,0)'), 'number'),
      fx('is_period_locked', wLA('IF(COUNTIFS([PAYROLL_CONTROL.period_start],"<="&@from_date,[PAYROLL_CONTROL.period_end],">="&@from_date,[PAYROLL_CONTROL.status],"LOCKED",[PAYROLL_CONTROL.run_type],"REGULAR")>0,1,0)'), 'number'),
    ],
  },
  {
    name: LB, group: 'Leave', protection: 'FORMULA_ONLY', capacity: 4000, keyColumn: 'balance_id',
    purpose: 'Balance per employee x leave type x leave year, computed from LEAVE_TRANSACTIONS. accrual_pending is what the monthly accrual job must post as an ACCRUAL transaction.',
    columns: [
      id('balance_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), id('leave_type_id', { ref: 'LEAVE_TYPES.leave_type_id' }), inp('leave_year', 'number', { required: true }), ...aud('RECORD_STATUS'),
      fx('balance_key', wLB('@employee_id&":"&@leave_type_id&":"&@leave_year'), 'text'),
      fx('credited', wLB('SUMIFS([LEAVE_TRANSACTIONS.days],[LEAVE_TRANSACTIONS.balance_key],@balance_key,[LEAVE_TRANSACTIONS.days],">0")'), 'number'),
      fx('debited', wLB('-SUMIFS([LEAVE_TRANSACTIONS.days],[LEAVE_TRANSACTIONS.balance_key],@balance_key,[LEAVE_TRANSACTIONS.days],"<0")'), 'number'),
      fx('balance', wLB('@credited-@debited'), 'number'),
      fx('pending_approval', wLB('SUMIFS([LEAVE_APPLICATIONS.days_count],[LEAVE_APPLICATIONS.balance_key],@balance_key,[LEAVE_APPLICATIONS.status],"PENDING",[LEAVE_APPLICATIONS.is_leave_like],"Y")'), 'number'),
      fx('available', wLB('@balance-@pending_approval'), 'number'),
      fx('emp_type', wLB('$LKD(EMPLOYEES.employment_type,EMPLOYEES.employee_id,@employee_id,"PERMANENT")'), 'text'),
      fx('policy_key', wLB('@leave_type_id&":"&@emp_type'), 'text'),
      fx('allow_negative', wLB('$LKD(LEAVE_TYPES.allow_negative,LEAVE_TYPES.leave_type_id,@leave_type_id,"N")'), 'text'),
      fx('max_negative', wLB('N($LKD(LEAVE_TYPES.max_negative_days,LEAVE_TYPES.leave_type_id,@leave_type_id,0))'), 'number'),
      fx('quota', wLB('N($LKD(LEAVE_POLICIES.annual_quota,LEAVE_POLICIES.policy_key,@policy_key,0))'), 'number'),
      fx('per_month', wLB('N($LKD(LEAVE_POLICIES.accrual_days_per_month,LEAVE_POLICIES.policy_key,@policy_key,0))'), 'number'),
      fx('method', wLB('$LKD(LEAVE_POLICIES.accrual_method,LEAVE_POLICIES.policy_key,@policy_key,"MANUAL")'), 'text'),
      fx('prorate', wLB('$LKD(LEAVE_POLICIES.prorate_joiners,LEAVE_POLICIES.policy_key,@policy_key,"Y")'), 'text'),
      fx('eligible_from', wLB('IF($LKD(LEAVE_POLICIES.probation_lock,LEAVE_POLICIES.policy_key,@policy_key,"N")="Y",MAX(N($LKD(EMPLOYEES.date_of_joining,EMPLOYEES.employee_id,@employee_id,0)),N($LKD(EMPLOYEES.probation_end_date,EMPLOYEES.employee_id,@employee_id,0))),N($LKD(EMPLOYEES.date_of_joining,EMPLOYEES.employee_id,@employee_id,0)))'), 'date'),
      fx('year_start', wLB('DATE(@leave_year,$CFG(LEAVE_YEAR_START_MONTH),1)'), 'date'),
      fx('accrual_start', wLB('MAX(@year_start,@eligible_from)'), 'date'),
      fx('start_offset_months', wLB('(YEAR(@accrual_start)-YEAR(@year_start))*12+MONTH(@accrual_start)-MONTH(@year_start)'), 'number'),
      fx('months_elapsed', wLB('IF($CFG(ACCRUAL_AS_OF_DATE)<@accrual_start,0,MAX(0,MIN(12-@start_offset_months,(YEAR($CFG(ACCRUAL_AS_OF_DATE))-YEAR(@accrual_start))*12+MONTH($CFG(ACCRUAL_AS_OF_DATE))-MONTH(@accrual_start)+1)))'), 'number'),
      fx('accrual_target', wLB('IF(@method="MANUAL",0,IF(@method="ANNUAL_UPFRONT",IF($CFG(ACCRUAL_AS_OF_DATE)<@accrual_start,0,ROUND(@quota*IF(@prorate="Y",(12-@start_offset_months)/12,1)*2,0)/2),MIN(@quota,ROUND(@per_month*@months_elapsed,2))))'), 'number'),
      fx('accrued_so_far', wLB('SUMIFS([LEAVE_TRANSACTIONS.days],[LEAVE_TRANSACTIONS.balance_key],@balance_key,[LEAVE_TRANSACTIONS.txn_type],"ACCRUAL")'), 'number'),
      fx('accrual_pending', wLB('MAX(0,ROUND(@accrual_target-@accrued_so_far,2))'), 'number', { note: 'amount the accrual job posts as an ACCRUAL transaction' }),
      fx('carry_forward_eligible', wLB('MIN(MAX(@balance,0),N($LKD(LEAVE_POLICIES.max_carry_forward,LEAVE_POLICIES.policy_key,@policy_key,0)))'), 'number'),
      fx('encashable_days', wLB('MIN(MAX(@balance,0),N($LKD(LEAVE_POLICIES.max_encashable,LEAVE_POLICIES.policy_key,@policy_key,0)))'), 'number'),
      fx('lapse_days', wLB('MAX(0,@balance-@carry_forward_eligible)'), 'number'),
      fx('negative_flag', wLB('IF(@allow_negative<>"Y",IF(@balance<0,1,0),IF(@balance<-@max_negative,1,0))'), 'number'),
      fx('dup_check', wLB('IF(COUNTIFS([LEAVE_BALANCES.balance_key],@balance_key)>1,"DUPLICATE","OK")'), 'text'),
    ],
  },
];
