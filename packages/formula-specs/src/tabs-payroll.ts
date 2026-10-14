import { TabDef, aud, en, fx, id, inp } from './dsl';

const PI = 'PAYROLL_INPUTS';
const PC = 'PAYROLL_CALC';
const SC = 'STATUTORY_CALC';

/** [column in EMPLOYEE_SALARY, component_code, calc-tab suffix] */
export const COMPONENTS: Array<[string, string, string]> = [
  ['basic', 'BASIC', 'basic'], ['hra', 'HRA', 'hra'], ['da', 'DA', 'da'], ['conveyance', 'CONVEYANCE', 'conveyance'],
  ['special_allowance', 'SPECIAL', 'special'], ['other_allowance', 'OTHER', 'other'],
  ['custom_earning_1', 'CUSTOM1', 'custom1'], ['custom_earning_2', 'CUSTOM2', 'custom2'],
];

const wPI = (e: string) => `IF(@input_id="","",${e})`;
const wPC = (e: string) => `IF(@input_id="","",${e})`;
const pi = (col: string) => `INDEX([${PI}.${col}],@pi_row)`;
const pcRow = (col: string) => `IFERROR(INDEX([${PC}.${col}],@pc_row),0)`;
const rule = (code: string) => `$RULE(${code},@period_end)`;
const flagged = (flag: string) => COMPONENTS.map(([, code, k]) => `IF($LKD(SALARY_COMPONENTS.${flag},SALARY_COMPONENTS.component_code,"${code}","N")="Y",@earned_${k},0)`).join('+');
const pcDates = (tabRange: string) => `[${tabRange}.employee_id],@employee_id,[${tabRange}.work_date],">="&@period_start,[${tabRange}.work_date],"<="&@period_end`;

const monthly = COMPONENTS.map(([col, , k]) =>
  fx(`monthly_${k}`, wPC(`IF(@sal_row_b=0,0,(IF(@sal_row_a=0,0,INDEX([EMPLOYEE_SALARY.${col}],@sal_row_a))*@days_a+INDEX([EMPLOYEE_SALARY.${col}],@sal_row_b)*@days_b)/@dim)`), 'money'));
const earned = COMPONENTS.map(([, , k]) => fx(`earned_${k}`, wPC(`ROUND(@monthly_${k}*@paid_days/@dim,2)`), 'money'));

export const PAYROLL_TABS: TabDef[] = [
  {
    name: 'SALARY_COMPONENTS', group: 'Payroll', protection: 'FORMULA_ONLY', capacity: 100, keyColumn: 'component_id', cacheable: true,
    purpose: 'Component definitions and their statutory flags (PF wage, ESI wage, taxable). Flags drive the statutory wage formulas.',
    columns: [
      id('component_id'), inp('component_code', 'text', { required: true }), inp('name', 'text', { required: true }), en('component_type', 'COMPONENT_TYPE'),
      en('taxable', 'YN'), en('pf_wage', 'YN'), en('esi_wage', 'YN'), en('ot_base', 'YN'), inp('display_order', 'number'),
      inp('effective_from', 'date'), inp('effective_to', 'date'), ...aud(),
    ],
  },
  {
    name: 'EMPLOYEE_SALARY', group: 'Payroll', protection: 'FORMULA_ONLY', capacity: 4000, keyColumn: 'salary_id',
    purpose: 'Effective-dated monthly salary assignment. A revision is a NEW row with a later effective_from; old rows are never edited.',
    columns: [
      id('salary_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), inp('effective_from', 'date', { required: true }), inp('effective_to', 'date'),
      inp('basic', 'money'), inp('hra', 'money'), inp('da', 'money'), inp('conveyance', 'money'), inp('special_allowance', 'money'), inp('other_allowance', 'money'),
      inp('custom_earning_1', 'money'), inp('custom_earning_2', 'money'), inp('revision_reason'), inp('version', 'number'), ...aud('RECORD_STATUS'),
      fx('salary_key', 'IF(@salary_id="","",@employee_id&":"&@effective_from)', 'text'),
      fx('monthly_gross', 'IF(@salary_id="","",N(@basic)+N(@hra)+N(@da)+N(@conveyance)+N(@special_allowance)+N(@other_allowance)+N(@custom_earning_1)+N(@custom_earning_2))', 'money'),
      fx('dup_check', 'IF(@salary_id="","",IF(COUNTIFS([EMPLOYEE_SALARY.salary_key],@salary_key,[EMPLOYEE_SALARY.status],"ACTIVE")>1,"DUPLICATE_EFFECTIVE_DATE","OK"))', 'text'),
    ],
  },
  {
    name: 'PAYROLL_CONTROL', group: 'Payroll', protection: 'FORMULA_ONLY', capacity: 200, keyColumn: 'period_id',
    purpose: 'Payroll period lifecycle OPEN -> PROCESSING -> REVIEW -> APPROVED -> LOCKED. LOCKED is terminal; a new version/off-cycle run is required for changes.',
    columns: [
      id('period_id'), inp('period_label', 'text', { required: true }), inp('period_start', 'date', { required: true }), inp('period_end', 'date', { required: true }),
      inp('cutoff_date', 'date'), en('run_type', 'RUN_TYPE', { required: true }), inp('version', 'number'), inp('submitted_by'), inp('approved_by'), inp('approved_at', 'datetime'),
      inp('locked_by'), inp('locked_at', 'datetime'), inp('snapshot_hash'), ...aud('PAYROLL_STATUS'),
      fx('days_in_period', 'IF(@period_id="","",@period_end-@period_start+1)', 'number'),
      fx('employee_rows', 'IF(@period_id="","",COUNTIFS([PAYROLL_INPUTS.period_id],@period_id))', 'number'),
      fx('total_gross', 'IF(@period_id="","",SUMIFS([PAYROLL_CALC.gross_earnings],[PAYROLL_CALC.period_id],@period_id))', 'money'),
      fx('total_net', 'IF(@period_id="","",SUMIFS([PAYROLL_CALC.net_pay],[PAYROLL_CALC.period_id],@period_id))', 'money'),
      fx('total_employer_cost', 'IF(@period_id="","",SUMIFS([PAYROLL_CALC.employer_cost],[PAYROLL_CALC.period_id],@period_id))', 'money'),
      fx('issue_count', 'IF(@period_id="","",COUNTIFS([PAYROLL_CALC.period_id],@period_id,[PAYROLL_CALC.check_status],"<>OK"))', 'number'),
      fx('ready_to_approve', 'IF(@period_id="","",IF(AND(@employee_rows>0,@issue_count=0),"YES","NO"))', 'text'),
    ],
  },
  {
    name: PI, group: 'Payroll', protection: 'FORMULA_ONLY', capacity: 2000, keyColumn: 'input_id',
    purpose: 'One row per employee x period. Manual inputs (bonus, incentive, arrears, adjustments) are separated from formula-derived attendance / leave / OT / loan / reimbursement inputs.',
    columns: [
      id('input_id'), id('period_id', { ref: 'PAYROLL_CONTROL.period_id' }), id('employee_id', { ref: 'EMPLOYEES.employee_id' }),
      inp('bonus', 'money'), inp('incentive', 'money'), inp('arrears', 'money', { note: 'retro / revision arrears, approved amount' }),
      inp('manual_adjustment', 'money', { note: 'signed, requires reason' }), inp('manual_adjustment_reason'), inp('other_deduction', 'money'),
      en('tds_manual_flag', 'YN'), inp('tds_manual_amount', 'money'), inp('remarks'), ...aud(),
      fx('period_start', wPI('$LKD(PAYROLL_CONTROL.period_start,PAYROLL_CONTROL.period_id,@period_id,0)'), 'date'),
      fx('period_end', wPI('$LKD(PAYROLL_CONTROL.period_end,PAYROLL_CONTROL.period_id,@period_id,0)'), 'date'),
      fx('dim', wPI('@period_end-@period_start+1'), 'number'),
      fx('emp_join', wPI('N($LKD(EMPLOYEES.date_of_joining,EMPLOYEES.employee_id,@employee_id,0))'), 'date'),
      fx('emp_exit', wPI('N($LKD(EMPLOYEES.date_of_exit,EMPLOYEES.employee_id,@employee_id,0))'), 'date'),
      fx('window_start', wPI('MAX(@period_start,@emp_join)'), 'date'),
      fx('window_end', wPI('IF(@emp_exit>0,MIN(@period_end,@emp_exit),@period_end)'), 'date'),
      fx('window_days', wPI('MAX(0,@window_end-@window_start+1)'), 'number'),
      fx('att_rows', wPI(`COUNTIFS(${pcDates('ATTENDANCE_DAILY')},[ATTENDANCE_DAILY.in_service],1)`), 'number'),
      fx('paid_days', wPI(`SUMIFS([ATTENDANCE_DAILY.day_credit],${pcDates('ATTENDANCE_DAILY')})`), 'number'),
      fx('lop_days', wPI(`SUMIFS([ATTENDANCE_DAILY.lop_days],${pcDates('ATTENDANCE_DAILY')})`), 'number'),
      fx('unresolved_exceptions', wPI(`SUMIFS([ATTENDANCE_DAILY.exception_open],${pcDates('ATTENDANCE_DAILY')})`), 'number'),
      fx('ot_reg_min', wPI(`SUMIFS([OVERTIME.payable_minutes],[OVERTIME.employee_id],@employee_id,[OVERTIME.work_date],">="&@period_start,[OVERTIME.work_date],"<="&@period_end,[OVERTIME.day_type],"REGULAR")`), 'number'),
      fx('ot_off_min', wPI(`SUMIFS([OVERTIME.payable_minutes],[OVERTIME.employee_id],@employee_id,[OVERTIME.work_date],">="&@period_start,[OVERTIME.work_date],"<="&@period_end,[OVERTIME.day_type],"OFFDAY")`), 'number'),
      fx('ot_night_min', wPI(`SUMIFS([OVERTIME.payable_night_minutes],[OVERTIME.employee_id],@employee_id,[OVERTIME.work_date],">="&@period_start,[OVERTIME.work_date],"<="&@period_end)`), 'number'),
      fx('reimbursement', wPI(`SUMIFS([REIMBURSEMENTS.amount],[REIMBURSEMENTS.employee_id],@employee_id,[REIMBURSEMENTS.period_id],@period_id,[REIMBURSEMENTS.status],"APPROVED")`), 'money'),
      fx('loan_emi', wPI(`SUMIFS([LOAN_SCHEDULE.emi_amount],[LOAN_SCHEDULE.employee_id],@employee_id,[LOAN_SCHEDULE.due_period_id],@period_id,[LOAN_SCHEDULE.status],"SCHEDULED",[LOAN_SCHEDULE.loan_type],"LOAN")`), 'money'),
      fx('advance_recovery', wPI(`SUMIFS([LOAN_SCHEDULE.emi_amount],[LOAN_SCHEDULE.employee_id],@employee_id,[LOAN_SCHEDULE.due_period_id],@period_id,[LOAN_SCHEDULE.status],"SCHEDULED",[LOAN_SCHEDULE.loan_type],"ADVANCE")`), 'money'),
      fx('run_type', wPI('$LKD(PAYROLL_CONTROL.run_type,PAYROLL_CONTROL.period_id,@period_id,"REGULAR")'), 'text'),
      fx('input_health', wPI('IF(@run_type<>"REGULAR","OK",IF(@att_rows<>@window_days,"MISSING_ATTENDANCE_ROWS",IF(@unresolved_exceptions>0,"UNRESOLVED_EXCEPTIONS","OK")))'), 'text'),
      fx('dup_check', wPI('IF(COUNTIFS([PAYROLL_INPUTS.period_id],@period_id,[PAYROLL_INPUTS.employee_id],@employee_id)>1,"DUPLICATE","OK")'), 'text'),
    ],
  },
  {
    name: PC, group: 'Payroll', protection: 'FORMULA_ONLY', capacity: 2000, keyColumn: 'input_id',
    purpose: 'Formula-driven payroll calculation. Salary is effective-dated with mid-period revision blending; components are prorated by paid days; statutory results come from STATUTORY_CALC.',
    columns: [
      id('input_id', { ref: 'PAYROLL_INPUTS.input_id' }), inp('company_id'), inp('created_at', 'datetime'), inp('created_by'), inp('request_id'),
      fx('pi_row', 'IF(@input_id="","",IFERROR(MATCH(@input_id,[PAYROLL_INPUTS.input_id],0),0))', 'number'),
      fx('period_id', wPC(pi('period_id')), 'text'), fx('employee_id', wPC(pi('employee_id')), 'text'),
      fx('calc_key', wPC('@period_id&":"&@employee_id'), 'text'),
      fx('run_type', wPC(pi('run_type')), 'text'), fx('run_flag', wPC('IF(@run_type="REGULAR",1,0)'), 'number'),
      fx('period_start', wPC(pi('period_start')), 'date'), fx('period_end', wPC(pi('period_end')), 'date'), fx('dim', wPC(pi('dim')), 'number'),
      fx('paid_days', wPC(pi('paid_days') + '*@run_flag'), 'number'), fx('lop_days', wPC(pi('lop_days') + '*@run_flag'), 'number'),
      fx('eff_from_a', wPC('MAXIFS([EMPLOYEE_SALARY.effective_from],[EMPLOYEE_SALARY.employee_id],@employee_id,[EMPLOYEE_SALARY.effective_from],"<="&@period_start,[EMPLOYEE_SALARY.status],"ACTIVE")'), 'date'),
      fx('eff_from_b', wPC('MAXIFS([EMPLOYEE_SALARY.effective_from],[EMPLOYEE_SALARY.employee_id],@employee_id,[EMPLOYEE_SALARY.effective_from],"<="&@period_end,[EMPLOYEE_SALARY.status],"ACTIVE")'), 'date'),
      fx('sal_row_a', wPC('IF(@eff_from_a=0,0,IFERROR(MATCH(@employee_id&":"&@eff_from_a,[EMPLOYEE_SALARY.salary_key],0),0))'), 'number'),
      fx('sal_row_b', wPC('IF(@eff_from_b=0,0,IFERROR(MATCH(@employee_id&":"&@eff_from_b,[EMPLOYEE_SALARY.salary_key],0),0))'), 'number'),
      fx('rev_date', wPC('IF(AND(@sal_row_a>0,@eff_from_b>@eff_from_a),@eff_from_b,0)'), 'date', { note: 'mid-period salary revision date (single revision per period supported)' }),
      fx('days_a', wPC('IF(@rev_date>0,@rev_date-@period_start,0)'), 'number'), fx('days_b', wPC('@dim-@days_a'), 'number'),
      ...monthly,
      fx('monthly_contract_gross', wPC(COMPONENTS.map(([, , k]) => `@monthly_${k}`).join('+')), 'money'),
      ...earned,
      fx('earned_fixed_total', wPC(COMPONENTS.map(([, , k]) => `@earned_${k}`).join('+')), 'money'),
      fx('ot_hourly', wPC('ROUND((@monthly_basic+@monthly_da)/@dim/$CFG(OT_HOURS_PER_DAY),4)'), 'money'),
      fx('ot_reg_min', wPC(pi('ot_reg_min') + '*@run_flag'), 'number'), fx('ot_off_min', wPC(pi('ot_off_min') + '*@run_flag'), 'number'), fx('ot_night_min', wPC(pi('ot_night_min') + '*@run_flag'), 'number'),
      fx('ot_amount', wPC(`ROUND(@ot_hourly*(@ot_reg_min/60*${rule('OT_MULT_REGULAR')}+@ot_off_min/60*${rule('OT_MULT_OFFDAY')}+@ot_night_min/60*${rule('OT_NIGHT_EXTRA')}),2)`), 'money'),
      fx('bonus', wPC('N(' + pi('bonus') + ')'), 'money'), fx('incentive', wPC('N(' + pi('incentive') + ')'), 'money'),
      fx('arrears', wPC('N(' + pi('arrears') + ')'), 'money'), fx('manual_adjustment', wPC('N(' + pi('manual_adjustment') + ')'), 'money'),
      fx('gross_earnings', wPC('@earned_fixed_total+@ot_amount+@bonus+@incentive+@arrears+@manual_adjustment'), 'money'),
      fx('pf_wage_earned', wPC(flagged('pf_wage')), 'money'), fx('esi_wage_earned', wPC(flagged('esi_wage')), 'money'),
      fx('taxable_earnings', wPC(flagged('taxable') + '+@ot_amount+@bonus+@incentive+@arrears+@manual_adjustment'), 'money'),
      fx('sc_row', wPC(`IFERROR(MATCH(@input_id,[${SC}.input_id],0),0)`), 'number'),
      fx('pf_emp', wPC(`IF(@sc_row=0,0,INDEX([${SC}.pf_emp],@sc_row))`), 'money'), fx('pf_er', wPC(`IF(@sc_row=0,0,INDEX([${SC}.pf_er],@sc_row))`), 'money'),
      fx('esi_emp', wPC(`IF(@sc_row=0,0,INDEX([${SC}.esi_emp],@sc_row))`), 'money'), fx('esi_er', wPC(`IF(@sc_row=0,0,INDEX([${SC}.esi_er],@sc_row))`), 'money'),
      fx('pt', wPC(`IF(@sc_row=0,0,INDEX([${SC}.pt],@sc_row))`), 'money'),
      fx('lwf_emp', wPC(`IF(@sc_row=0,0,INDEX([${SC}.lwf_emp],@sc_row))`), 'money'), fx('lwf_er', wPC(`IF(@sc_row=0,0,INDEX([${SC}.lwf_er],@sc_row))`), 'money'),
      fx('tds', wPC(`IF(@sc_row=0,0,INDEX([${SC}.tds],@sc_row))`), 'money'),
      fx('loan_emi', wPC(pi('loan_emi') + '*@run_flag'), 'money'), fx('advance_recovery', wPC(pi('advance_recovery') + '*@run_flag'), 'money'),
      fx('other_deduction', wPC('N(' + pi('other_deduction') + ')'), 'money'), fx('reimbursement', wPC(pi('reimbursement')), 'money'),
      fx('total_deductions', wPC('@pf_emp+@esi_emp+@pt+@lwf_emp+@tds+@loan_emi+@advance_recovery+@other_deduction'), 'money'),
      fx('net_pay', wPC('ROUND(@gross_earnings+@reimbursement-@total_deductions,2)'), 'money'),
      fx('employer_cost', wPC('ROUND(@gross_earnings+@reimbursement+@pf_er+@esi_er+@lwf_er,2)'), 'money'),
      fx('period_status', wPC('$LKD(PAYROLL_CONTROL.status,PAYROLL_CONTROL.period_id,@period_id,"")'), 'text'),
      fx('check_status', wPC('IF(@run_flag=1,IF(@sal_row_b=0,"NO_SALARY_STRUCTURE",IF(' + pi('input_health') + '<>"OK",' + pi('input_health') + ',IF(@net_pay<0,"NEGATIVE_NET","OK"))),IF(@net_pay<0,"NEGATIVE_NET","OK"))'), 'text'),
    ],
  },
  {
    name: SC, group: 'Payroll', protection: 'FORMULA_ONLY', capacity: 2000, keyColumn: 'input_id',
    purpose: 'Statutory results (PF, ESI, PT, LWF, TDS). All rates/thresholds are read from effective-dated STATUTORY_RULES rows; nothing is hard-coded.',
    columns: [
      id('input_id', { ref: 'PAYROLL_INPUTS.input_id' }), inp('company_id'), inp('created_at', 'datetime'), inp('created_by'), inp('request_id'),
      fx('pc_row', 'IF(@input_id="","",IFERROR(MATCH(@input_id,[PAYROLL_CALC.input_id],0),0))', 'number'),
      fx('pi_row', 'IF(@input_id="","",IFERROR(MATCH(@input_id,[PAYROLL_INPUTS.input_id],0),0))', 'number'),
      fx('period_end', 'IF(@input_id="","",INDEX([PAYROLL_INPUTS.period_end],@pi_row))', 'date'),
      fx('employee_id', 'IF(@input_id="","",INDEX([PAYROLL_INPUTS.employee_id],@pi_row))', 'text'),
      fx('run_flag', 'IF(@input_id="","",IF(INDEX([PAYROLL_INPUTS.run_type],@pi_row)="REGULAR",1,0))', 'number'),
      fx('pf_applicable', 'IF(@input_id="","",$LKD(EMPLOYEES.pf_applicable,EMPLOYEES.employee_id,@employee_id,"N"))', 'text'),
      fx('esi_applicable', 'IF(@input_id="","",$LKD(EMPLOYEES.esi_applicable,EMPLOYEES.employee_id,@employee_id,"N"))', 'text'),
      fx('pt_applicable', 'IF(@input_id="","",$LKD(EMPLOYEES.pt_applicable,EMPLOYEES.employee_id,@employee_id,"N"))', 'text'),
      fx('gross_earnings', 'IF(@input_id="","",' + pcRow('gross_earnings') + ')', 'money'),
      fx('pf_wage_earned', 'IF(@input_id="","",' + pcRow('pf_wage_earned') + ')', 'money'),
      fx('esi_wage_earned', 'IF(@input_id="","",' + pcRow('esi_wage_earned') + ')', 'money'),
      fx('taxable_earnings', 'IF(@input_id="","",' + pcRow('taxable_earnings') + ')', 'money'),
      fx('contract_gross', 'IF(@input_id="","",' + pcRow('monthly_contract_gross') + ')', 'money'),
      fx('pf_wage_capped', 'IF(@input_id="","",IF(AND(@pf_applicable="Y",@run_flag=1),IF($RULE(PF_CEILING_ENABLED,@period_end)=1,MIN(@pf_wage_earned,$RULE(PF_WAGE_CEILING,@period_end)),@pf_wage_earned),0))', 'money'),
      fx('pf_emp', 'IF(@input_id="","",ROUND(@pf_wage_capped*$RULE(PF_EMP_RATE,@period_end),0))', 'money'),
      fx('pf_er', 'IF(@input_id="","",ROUND(@pf_wage_capped*$RULE(PF_ER_RATE,@period_end),0))', 'money'),
      fx('esi_eligible', 'IF(@input_id="","",IF(AND(@esi_applicable="Y",@run_flag=1,@contract_gross<=$RULE(ESI_GROSS_CEILING,@period_end)),1,0))', 'number'),
      fx('esi_emp', 'IF(@input_id="","",ROUNDUP(@esi_wage_earned*$RULE(ESI_EMP_RATE,@period_end)*@esi_eligible,0))', 'money'),
      fx('esi_er', 'IF(@input_id="","",ROUNDUP(@esi_wage_earned*$RULE(ESI_ER_RATE,@period_end)*@esi_eligible,0))', 'money'),
      fx('pt', 'IF(@input_id="","",IF(AND(@pt_applicable="Y",@run_flag=1),IF(AND($RULE(PT_SLAB2_FROM,@period_end)>0,@gross_earnings>=$RULE(PT_SLAB2_FROM,@period_end)),$RULE(PT_SLAB2_AMOUNT,@period_end),IF(AND($RULE(PT_SLAB1_FROM,@period_end)>0,@gross_earnings>=$RULE(PT_SLAB1_FROM,@period_end)),$RULE(PT_SLAB1_AMOUNT,@period_end),0)),0))', 'money'),
      fx('lwf_emp', 'IF(@input_id="","",IF(AND(@run_flag=1,MONTH(@period_end)=$RULE(LWF_APPLY_MONTH,@period_end)),$RULE(LWF_EMP,@period_end),0))', 'money'),
      fx('lwf_er', 'IF(@input_id="","",IF(AND(@run_flag=1,MONTH(@period_end)=$RULE(LWF_APPLY_MONTH,@period_end)),$RULE(LWF_ER,@period_end),0))', 'money'),
      fx('tds', 'IF(@input_id="","",IF(INDEX([PAYROLL_INPUTS.tds_manual_flag],@pi_row)="Y",N(INDEX([PAYROLL_INPUTS.tds_manual_amount],@pi_row)),IF(AND($RULE(TDS_FLAT_RATE,@period_end)>0,@taxable_earnings>=$RULE(TDS_MIN_MONTHLY_TAXABLE,@period_end)),ROUND(@taxable_earnings*$RULE(TDS_FLAT_RATE,@period_end),0),0)))', 'money',
        { note: 'manual amount (finance computes slab tax externally) or optional flat-rate rule; full slab engine is a configurable extension' }),
    ],
  },
  {
    name: 'PAYROLL_SNAPSHOT', group: 'Payroll', protection: 'SERVICE_ONLY', appendOnly: true, capacity: 20000, keyColumn: 'snapshot_id',
    purpose: 'Immutable VALUES copy of PAYROLL_CALC written at LOCK. Locked periods are reported from here so history is reproducible after salary / policy / rule changes.',
    columns: [
      id('snapshot_id'), id('period_id'), inp('period_version', 'number'), id('employee_id'), inp('paid_days', 'number'), inp('lop_days', 'number'),
      inp('gross_earnings', 'money'), inp('pf_emp', 'money'), inp('esi_emp', 'money'), inp('pt', 'money'), inp('lwf_emp', 'money'), inp('tds', 'money'),
      inp('loan_emi', 'money'), inp('advance_recovery', 'money'), inp('other_deduction', 'money'), inp('reimbursement', 'money'),
      inp('total_deductions', 'money'), inp('net_pay', 'money'), inp('employer_cost', 'money'), inp('calc_json', 'json'), inp('inputs_json', 'json'), inp('rules_json', 'json'),
      inp('row_hash'), inp('locked_at', 'datetime'), inp('locked_by'), inp('request_id'),
    ],
  },
  {
    name: 'PAYSLIPS', group: 'Payroll', protection: 'FORMULA_ONLY', capacity: 20000, keyColumn: 'payslip_id',
    purpose: 'Payslip index. PDFs live in a restricted Drive folder; only IDs and checksums are stored here.',
    columns: [
      id('payslip_id'), id('period_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), id('snapshot_id'), inp('drive_file_id'), inp('file_name'),
      inp('checksum'), inp('generated_at', 'datetime'), inp('generated_by'), inp('published_at', 'datetime'), ...aud(),
      fx('net_pay', 'IF(@payslip_id="","",$LKD(PAYROLL_SNAPSHOT.net_pay,PAYROLL_SNAPSHOT.snapshot_id,@snapshot_id,0))', 'money'),
    ],
  },
  {
    name: 'LOANS', group: 'Payroll', protection: 'FORMULA_ONLY', capacity: 1500, keyColumn: 'loan_id',
    purpose: 'Loan / advance master. EMI is computed with PMT in the sheet.',
    columns: [
      id('loan_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), en('loan_type', 'LOAN_TYPE', { required: true }), inp('principal', 'money', { required: true }),
      inp('annual_interest_rate', 'percent'), inp('tenure_months', 'number', { required: true }), inp('start_period_id'), inp('disbursed_on', 'date'), inp('purpose'),
      id('approver_employee_id', { required: false }), inp('approved_at', 'datetime'), ...aud('LOAN_STATUS'),
      fx('emi', 'IF(@loan_id="","",IF(@annual_interest_rate=0,ROUND(@principal/@tenure_months,2),ROUND(-PMT(@annual_interest_rate/12,@tenure_months,@principal),2)))', 'money'),
      fx('total_repayable', 'IF(@loan_id="","",ROUND(@emi*@tenure_months,2))', 'money'),
      fx('recovered', 'IF(@loan_id="","",SUMIFS([LOAN_SCHEDULE.emi_amount],[LOAN_SCHEDULE.loan_id],@loan_id,[LOAN_SCHEDULE.status],"DEDUCTED"))', 'money'),
      fx('outstanding', 'IF(@loan_id="","",@total_repayable-@recovered)', 'money'),
    ],
  },
  {
    name: 'LOAN_SCHEDULE', group: 'Payroll', protection: 'FORMULA_ONLY', capacity: 10000, keyColumn: 'schedule_id',
    purpose: 'Installments. Rows are SCHEDULED until payroll lock marks them DEDUCTED.',
    columns: [
      id('schedule_id'), id('loan_id', { ref: 'LOANS.loan_id' }), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), en('loan_type', 'LOAN_TYPE'), inp('installment_no', 'number'),
      id('due_period_id', { ref: 'PAYROLL_CONTROL.period_id' }), inp('deducted_in_period_id'), inp('deducted_at', 'datetime'), ...aud('SCHEDULE_STATUS'),
      fx('emi_amount', 'IF(@schedule_id="","",$LKD(LOANS.emi,LOANS.loan_id,@loan_id,0))', 'money'),
    ],
  },
  {
    name: 'EXPENSES', group: 'Payroll', protection: 'FORMULA_ONLY', capacity: 5000, keyColumn: 'expense_id',
    purpose: 'Expense claims and approval state. Approved claims create REIMBURSEMENTS rows.',
    columns: [
      id('expense_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), inp('expense_date', 'date', { required: true }), inp('category'), inp('description'),
      inp('amount', 'money', { required: true }), inp('currency'), inp('receipt_drive_file_id'), id('approver_employee_id', { required: false }),
      inp('decided_at', 'datetime'), inp('decided_by'), inp('decision_note'), ...aud('EXPENSE_STATUS'),
    ],
  },
  {
    name: 'REIMBURSEMENTS', group: 'Payroll', protection: 'FORMULA_ONLY', capacity: 5000, keyColumn: 'reimbursement_id',
    purpose: 'Approved reimbursement inputs consumed by PAYROLL_INPUTS (status APPROVED, matching period_id).',
    columns: [
      id('reimbursement_id'), inp('expense_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), id('period_id', { ref: 'PAYROLL_CONTROL.period_id' }),
      inp('amount', 'money', { required: true }), inp('description'), ...aud('EXPENSE_STATUS'),
    ],
  },
  {
    name: 'TAX_DECLARATIONS', group: 'Payroll', protection: 'FORMULA_ONLY', capacity: 8000, keyColumn: 'declaration_id',
    purpose: 'Employee tax declarations and proofs (inputs to finance TDS computation).',
    columns: [
      id('declaration_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), inp('financial_year', 'text', { required: true }), en('regime', 'TAX_REGIME'),
      inp('section'), inp('description'), inp('declared_amount', 'money'), inp('proof_drive_file_id'), inp('verified_amount', 'money'), inp('verified_by'), ...aud('APPROVAL_STATUS'),
      fx('employee_fy_declared', 'IF(@declaration_id="","",SUMIFS([TAX_DECLARATIONS.declared_amount],[TAX_DECLARATIONS.employee_id],@employee_id,[TAX_DECLARATIONS.financial_year],@financial_year))', 'money'),
    ],
  },
  {
    name: 'STATUTORY_RULES', group: 'Compliance', protection: 'FORMULA_ONLY', capacity: 600, keyColumn: 'rule_id', cacheable: true,
    purpose: 'Versioned, effective-dated statutory configuration (PF, ESI, PT, LWF, TDS, OT multipliers, gratuity). Seeded values are ILLUSTRATIVE and must be verified against current law before production.',
    columns: [
      id('rule_id'), inp('rule_code', 'text', { required: true }), inp('description'), inp('value', 'number', { required: true }), inp('unit'),
      inp('effective_from', 'date', { required: true }), inp('effective_to', 'date'), inp('jurisdiction'), inp('version', 'number'), inp('source_note'), ...aud('RECORD_STATUS'),
      fx('effective_to_norm', 'IF(@rule_id="",0,IF(@effective_to="",2958465,@effective_to))', 'date'),
      fx('overlap_check', 'IF(@rule_id="","",IF(COUNTIFS([STATUTORY_RULES.rule_code],@rule_code,[STATUTORY_RULES.jurisdiction],@jurisdiction,[STATUTORY_RULES.effective_from],"<="&@effective_to_norm,[STATUTORY_RULES.effective_to_norm],">="&@effective_from,[STATUTORY_RULES.status],"ACTIVE")>1,"OVERLAPPING_RULE","OK"))', 'text'),
    ],
  },
  {
    name: 'FULL_FINAL', group: 'Payroll', protection: 'FORMULA_ONLY', capacity: 500, keyColumn: 'ff_id',
    purpose: 'Full & final settlement. Leave encashment, notice recovery, gratuity and loan recovery are formulas over ledger / salary / rule data.',
    columns: [
      id('ff_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), inp('last_working_day', 'date', { required: true }), inp('notice_period_days', 'number'), inp('notice_served_days', 'number'),
      id('exit_period_id', { ref: 'PAYROLL_CONTROL.period_id', required: false }), en('pending_salary_included', 'YN'), inp('other_dues_recoverable', 'money'), inp('other_payables', 'money'),
      id('approver_employee_id', { required: false }), inp('decided_at', 'datetime'), ...aud('FF_STATUS'),
      fx('join_date', 'IF(@ff_id="","",N($LKD(EMPLOYEES.date_of_joining,EMPLOYEES.employee_id,@employee_id,0)))', 'date'),
      fx('years_service', 'IF(@ff_id="","",ROUND((@last_working_day-@join_date)/365.25,2))', 'number'),
      fx('sal_from', 'IF(@ff_id="","",MAXIFS([EMPLOYEE_SALARY.effective_from],[EMPLOYEE_SALARY.employee_id],@employee_id,[EMPLOYEE_SALARY.effective_from],"<="&@last_working_day,[EMPLOYEE_SALARY.status],"ACTIVE"))', 'date'),
      fx('sal_row', 'IF(@ff_id="","",IF(@sal_from=0,0,IFERROR(MATCH(@employee_id&":"&@sal_from,[EMPLOYEE_SALARY.salary_key],0),0)))', 'number'),
      fx('monthly_gross', 'IF(@ff_id="","",IF(@sal_row=0,0,INDEX([EMPLOYEE_SALARY.monthly_gross],@sal_row)))', 'money'),
      fx('basic_da', 'IF(@ff_id="","",IF(@sal_row=0,0,N(INDEX([EMPLOYEE_SALARY.basic],@sal_row))+N(INDEX([EMPLOYEE_SALARY.da],@sal_row))))', 'money'),
      fx('pending_salary_net', 'IF(@ff_id="","",IF(@pending_salary_included="Y",0,$LKD(PAYROLL_CALC.net_pay,PAYROLL_CALC.calc_key,@exit_period_id&":"&@employee_id,0)))', 'money'),
      fx('ff_leave_year', 'IF(@ff_id="","",IF(MONTH(@last_working_day)>=$CFG(LEAVE_YEAR_START_MONTH),YEAR(@last_working_day),YEAR(@last_working_day)-1))', 'number'),
      fx('leave_encash_days', 'IF(@ff_id="","",SUMIFS([LEAVE_BALANCES.encashable_days],[LEAVE_BALANCES.employee_id],@employee_id,[LEAVE_BALANCES.leave_year],@ff_leave_year))', 'number'),
      fx('leave_encash_amount', 'IF(@ff_id="","",ROUND(@leave_encash_days*@basic_da/$RULE(LEAVE_ENCASH_DIVISOR,@last_working_day),2))', 'money'),
      fx('notice_shortfall_days', 'IF(@ff_id="","",MAX(0,N(@notice_period_days)-N(@notice_served_days)))', 'number'),
      fx('notice_recovery', 'IF(@ff_id="","",ROUND(@notice_shortfall_days*@monthly_gross/$RULE(NOTICE_RECOVERY_DIVISOR,@last_working_day),2))', 'money'),
      fx('gratuity_eligible', 'IF(@ff_id="","",IF(@years_service>=$RULE(GRATUITY_MIN_YEARS,@last_working_day),1,0))', 'number'),
      fx('gratuity_amount', 'IF(@ff_id="","",IF(@gratuity_eligible=1,MIN($RULE(GRATUITY_CAP,@last_working_day),ROUND(@basic_da*$RULE(GRATUITY_DAYS,@last_working_day)/$RULE(GRATUITY_DIVISOR,@last_working_day)*ROUND(@years_service,0),2)),0))', 'money'),
      fx('loan_outstanding', 'IF(@ff_id="","",SUMIFS([LOAN_SCHEDULE.emi_amount],[LOAN_SCHEDULE.employee_id],@employee_id,[LOAN_SCHEDULE.status],"SCHEDULED"))', 'money'),
      fx('total_payable', 'IF(@ff_id="","",@pending_salary_net+@leave_encash_amount+@gratuity_amount+N(@other_payables))', 'money'),
      fx('total_recoveries', 'IF(@ff_id="","",@notice_recovery+@loan_outstanding+N(@other_dues_recoverable))', 'money'),
      fx('net_full_final', 'IF(@ff_id="","",ROUND(@total_payable-@total_recoveries,2))', 'money'),
    ],
  },
];
export { aud };
