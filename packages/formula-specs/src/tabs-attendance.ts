import { TabDef, aud, en, fx, id, inp } from './dsl';

const EV = 'ATTENDANCE_EVENTS';
const AD = 'ATTENDANCE_DAILY';

/** wrap an ATTENDANCE_DAILY formula so blank scaffold rows stay blank */
const W = (e: string) => `IF(@attendance_id="","",${e})`;
const lk = (col: string, def: string) => `$LKD(SHIFT_MASTER.${col},SHIFT_MASTER.shift_id,@shift_id,${def})`;
const inRange = `[${EV}.employee_id],@employee_id,[${EV}.work_date],@work_date`;
const laWin = `[LEAVE_APPLICATIONS.employee_id],@employee_id,[LEAVE_APPLICATIONS.from_date],"<="&@work_date,[LEAVE_APPLICATIONS.to_date],">="&@work_date,[LEAVE_APPLICATIONS.status],"APPROVED"`;

/** Attendance calculation layer: raw events -> daily result -> adjustments / exceptions / overtime. */
export const ATTENDANCE_TABS: TabDef[] = [
  {
    name: EV, group: 'Attendance', protection: 'SERVICE_ONLY', appendOnly: true, capacity: 10000, keyColumn: 'event_id',
    purpose: 'Immutable raw punch events. Rows are only appended. Corrections go to ATTENDANCE_ADJUSTMENTS. event_datetime is company-local wall clock; event_datetime_utc is the audit instant.',
    columns: [
      id('event_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), inp('event_datetime', 'datetime', { required: true }), inp('event_datetime_utc', 'text'),
      en('event_type', 'EVENT_TYPE', { required: true }), en('capture_method', 'CAPTURE_METHOD'), inp('device_id'),
      inp('geo_lat', 'number', { note: 'latitude captured on the device at the moment of the punch (decimal degrees, WGS84)' }), inp('geo_lng', 'number', { note: 'longitude captured on the device at the moment of the punch' }),
      inp('geo_accuracy', 'number', { note: 'GPS accuracy radius in metres reported by the device' }), en('geo_status', 'GEO_STATUS'),
      inp('geo_distance_m', 'number', { note: 'metres between the punch and the branch centre (blank when the branch has no coordinates)' }), inp('idempotency_key'),
      ...aud('RECORD_STATUS'),
      fx('is_dup', 'IF(@event_id="","",IF(COUNTIFS([ATTENDANCE_EVENTS.employee_id],@employee_id,[ATTENDANCE_EVENTS.event_type],@event_type,[ATTENDANCE_EVENTS.event_datetime],">="&(@event_datetime-$CFG(DUPLICATE_WINDOW_SEC)/86400),[ATTENDANCE_EVENTS.event_datetime],"<"&@event_datetime)>0,1,0))', 'number',
        { note: 'same employee + type within DUPLICATE_WINDOW_SEC of an earlier punch' }),
      fx('prev_in_dt', 'IF(@event_id="","",IF(@event_type<>"OUT","",MAXIFS([ATTENDANCE_EVENTS.event_datetime],[ATTENDANCE_EVENTS.employee_id],@employee_id,[ATTENDANCE_EVENTS.event_type],"IN",[ATTENDANCE_EVENTS.event_datetime],"<"&@event_datetime,[ATTENDANCE_EVENTS.is_dup],0)))', 'datetime'),
      fx('prev_out_dt', 'IF(@event_id="","",IF(@event_type<>"OUT","",MAXIFS([ATTENDANCE_EVENTS.event_datetime],[ATTENDANCE_EVENTS.employee_id],@employee_id,[ATTENDANCE_EVENTS.event_type],"OUT",[ATTENDANCE_EVENTS.event_datetime],"<"&@event_datetime,[ATTENDANCE_EVENTS.is_dup],0)))', 'datetime'),
      fx('segment_minutes', 'IF(@event_id="","",IF(@event_type<>"OUT","",IF(AND(@is_dup=0,@prev_in_dt>0,@prev_in_dt>@prev_out_dt,(@event_datetime-@prev_in_dt)*24<=$CFG(MAX_SEGMENT_HOURS)),ROUND((@event_datetime-@prev_in_dt)*1440,2),0)))', 'number',
        { note: 'IN->OUT pairing: minutes between an OUT and the latest earlier valid IN that has no OUT in between' }),
      fx('work_date', 'IF(@event_id="","",IF(@event_type<>"OUT",INT(@event_datetime-$CFG(DAY_BOUNDARY_HOURS)/24),IF(AND(@prev_in_dt>0,(@event_datetime-@prev_in_dt)*24<=$CFG(MAX_SEGMENT_HOURS),@prev_in_dt>@prev_out_dt),INT(@prev_in_dt-$CFG(DAY_BOUNDARY_HOURS)/24),INT(@event_datetime-$CFG(DAY_BOUNDARY_HOURS)/24))))', 'date',
        { note: 'IN uses the day-boundary rule; a paired OUT inherits its IN work date, so night / cross-midnight shifts stay on one day' }),
      fx('map_url', 'IF(@event_id="","",IF(OR(@geo_lat="",@geo_lng=""),"","https://www.google.com/maps?q="&SUBSTITUTE(@geo_lat,",",".")&","&SUBSTITUTE(@geo_lng,",",".")))', 'text',
        { note: 'Google Maps link for the punch location, built from geo_lat / geo_lng' }),
    ],
  },
  {
    name: AD, group: 'Attendance', protection: 'FORMULA_ONLY', capacity: 6000, keyColumn: 'attendance_id',
    purpose: 'Final calculated daily attendance. Only employee_id and work_date are input (scaffolded per period); everything else is a formula derived from events + roster + holidays + leave + adjustments + shift policy.',
    columns: [
      id('attendance_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), inp('work_date', 'date', { required: true }),
      inp('company_id'), inp('created_at', 'datetime'), inp('created_by'), inp('request_id'), en('status_flag', 'RECORD_STATUS'),
      // ---- context ----
      fx('daily_key', W('@employee_id&":"&@work_date'), 'text'),
      fx('dup_check', W('IF(COUNTIFS([ATTENDANCE_DAILY.daily_key],@daily_key)>1,"DUPLICATE","OK")'), 'text'),
      fx('emp_join', W('N($LKD(EMPLOYEES.date_of_joining,EMPLOYEES.employee_id,@employee_id,0))'), 'date'),
      fx('emp_exit', W('N($LKD(EMPLOYEES.date_of_exit,EMPLOYEES.employee_id,@employee_id,0))'), 'date'),
      fx('in_service', W('IF(AND(@emp_join>0,@work_date>=@emp_join,OR(@emp_exit=0,@work_date<=@emp_exit)),1,0)'), 'number'),
      fx('location_id', W('$LKD(EMPLOYEES.location_id,EMPLOYEES.employee_id,@employee_id,"")'), 'text'),
      fx('ot_eligible', W('$LKD(EMPLOYEES.ot_eligible,EMPLOYEES.employee_id,@employee_id,"N")'), 'text'),
      fx('roster_shift', W('$LKD(SHIFT_ROSTER.shift_id,SHIFT_ROSTER.roster_key,@daily_key,"")'), 'text'),
      fx('roster_weekoff', W('$LKD(SHIFT_ROSTER.is_week_off,SHIFT_ROSTER.roster_key,@daily_key,"")'), 'text'),
      fx('shift_id', W('IF(@roster_shift<>"",@roster_shift,$LKD(EMPLOYEES.default_shift_id,EMPLOYEES.employee_id,@employee_id,""))'), 'text'),
      fx('is_week_off', W('IF(@roster_weekoff="Y",1,IF(@roster_weekoff="N",0,IF(MID($LKD(EMPLOYEES.weekend_mask,EMPLOYEES.employee_id,@employee_id,"0000000"),WEEKDAY(@work_date,2),1)="1",1,0)))'), 'number'),
      fx('is_holiday', W('IF(COUNTIFS([HOLIDAYS.effective_date],@work_date,[HOLIDAYS.location_id],"ALL")+COUNTIFS([HOLIDAYS.effective_date],@work_date,[HOLIDAYS.location_id],@location_id)>0,1,0)'), 'number'),
      // ---- shift parameters ----
      fx('sh_start', W(lk('start_time', '0')), 'time'), fx('sh_end', W(lk('end_time', '0')), 'time'),
      fx('sh_break', W(lk('break_minutes', '0')), 'number'), fx('sh_grace_in', W(lk('grace_in_minutes', '0')), 'number'),
      fx('sh_grace_out', W(lk('grace_out_minutes', '0')), 'number'), fx('sh_full', W(lk('full_day_minutes', '0')), 'number'),
      fx('sh_half', W(lk('half_day_minutes', '0')), 'number'), fx('sh_ot_thr', W(lk('ot_threshold_minutes', '0')), 'number'),
      fx('sh_flex', W(lk('is_flexible', '"N"')), 'text'),
      fx('shift_start_dt', W('IF(@shift_id="",0,@work_date+@sh_start)'), 'datetime'),
      fx('shift_end_dt', W('IF(@shift_id="",0,@work_date+@sh_end+IF(@sh_end<=@sh_start,1,0))'), 'datetime'),
      // ---- raw punches ----
      fx('first_in', W(`MINIFS([${EV}.event_datetime],${inRange},[${EV}.event_type],"IN",[${EV}.is_dup],0)`), 'datetime'),
      fx('last_out', W(`MAXIFS([${EV}.event_datetime],${inRange},[${EV}.event_type],"OUT",[${EV}.is_dup],0)`), 'datetime'),
      fx('last_in', W(`MAXIFS([${EV}.event_datetime],${inRange},[${EV}.event_type],"IN",[${EV}.is_dup],0)`), 'datetime'),
      fx('punch_count', W(`COUNTIFS(${inRange},[${EV}.is_dup],0)`), 'number'),
      fx('in_count', W(`COUNTIFS(${inRange},[${EV}.event_type],"IN",[${EV}.is_dup],0)`), 'number'),
      fx('out_count', W(`COUNTIFS(${inRange},[${EV}.event_type],"OUT",[${EV}.is_dup],0)`), 'number'),
      fx('seg_minutes', W(`SUMIFS([${EV}.segment_minutes],${inRange})`), 'number'),
      fx('seg_count', W(`COUNTIFS(${inRange},[${EV}.segment_minutes],">0")`), 'number'),
      // ---- approved adjustments (never overwrite raw) ----
      fx('adj_in', W('MAXIFS([ATTENDANCE_ADJUSTMENTS.adjusted_in],[ATTENDANCE_ADJUSTMENTS.employee_id],@employee_id,[ATTENDANCE_ADJUSTMENTS.work_date],@work_date,[ATTENDANCE_ADJUSTMENTS.status],"APPROVED")'), 'datetime'),
      fx('adj_out', W('MAXIFS([ATTENDANCE_ADJUSTMENTS.adjusted_out],[ATTENDANCE_ADJUSTMENTS.employee_id],@employee_id,[ATTENDANCE_ADJUSTMENTS.work_date],@work_date,[ATTENDANCE_ADJUSTMENTS.status],"APPROVED")'), 'datetime'),
      fx('eff_in', W('IF(@adj_in>0,@adj_in,@first_in)'), 'datetime'),
      fx('eff_out', W('IF(@adj_out>0,@adj_out,@last_out)'), 'datetime'),
      fx('worked_minutes', W('IF(OR(@adj_in>0,@adj_out>0),IF(AND(@eff_in>0,@eff_out>@eff_in),MAX(0,ROUND((@eff_out-@eff_in)*1440-@sh_break,0)),0),IF(@seg_count<=1,MAX(0,ROUND(@seg_minutes-IF(@seg_minutes>@sh_break,@sh_break,0),0)),ROUND(@seg_minutes,0)))'), 'number',
        { note: 'adjusted: span minus break; otherwise IN/OUT pairing (single segment deducts the shift break, multi-segment trusts break punches)' }),
      fx('open_now', W('IF(AND(@adj_in=0,@adj_out=0,@in_count=@out_count+1,@last_in>@last_out,@last_in<=$CFG(ATTENDANCE_AS_OF),($CFG(ATTENDANCE_AS_OF)-@last_in)*24<=$CFG(MAX_SEGMENT_HOURS)),1,0)'), 'number',
        { note: 'checked in and still inside a normal working window at ATTENDANCE_AS_OF: in progress, not a missing punch' }),
      fx('missing_punch', W('IF(OR(@adj_in>0,@adj_out>0),0,IF(AND(@in_count<>@out_count,@open_now=0),1,0))'), 'number'),
      // ---- leave / WFH / OD from approved applications ----
      fx('leave_paid_frac', W(`MIN(1,SUMIFS([LEAVE_APPLICATIONS.day_fraction],${laWin},[LEAVE_APPLICATIONS.is_leave_like],"Y",[LEAVE_APPLICATIONS.is_paid],"Y"))`), 'number'),
      fx('leave_unpaid_frac', W(`MIN(1,SUMIFS([LEAVE_APPLICATIONS.day_fraction],${laWin},[LEAVE_APPLICATIONS.is_leave_like],"Y",[LEAVE_APPLICATIONS.is_paid],"N"))`), 'number'),
      fx('wfh_od', W(`COUNTIFS(${laWin},[LEAVE_APPLICATIONS.is_workday_override],"Y")`), 'number'),
      // ---- result ----
      fx('grace_credit_minutes', W('IF(OR(@shift_id="",@sh_flex="Y",@eff_in=0,@eff_out=0,@missing_punch=1),0,IF(ROUND((@eff_in-@shift_start_dt)*1440,0)<=@sh_grace_in,MAX(0,ROUND((@eff_in-@shift_start_dt)*1440,0)),0))'), 'number',
        { note: 'arriving inside the grace window is not penalised when deciding full / half day' }),
      fx('worked_credit', W('IF(OR(@missing_punch=1,@worked_minutes<=0),0,IF(@worked_minutes+@grace_credit_minutes>=@sh_full,1,IF(@worked_minutes+@grace_credit_minutes>=@sh_half,0.5,0)))'), 'number'),
      fx('status', W('IF(@in_service=0,"NA",IF(@wfh_od>0,"WFH_OD",IF(@open_now=1,"IN_PROGRESS",IF(@is_holiday=1,IF(@worked_minutes>0,"HOLIDAY_WORK","HOLIDAY"),IF(@is_week_off=1,IF(@worked_minutes>0,"WEEKOFF_WORK","WEEKOFF"),IF(@leave_paid_frac+@leave_unpaid_frac>=1,IF(@leave_unpaid_frac>=1,"UNPAID_LEAVE","LEAVE"),IF(@missing_punch=1,"MISSING_PUNCH",IF(MIN(1,@worked_credit+@leave_paid_frac)>=1,"PRESENT",IF(MIN(1,@worked_credit+@leave_paid_frac)>0,"HALF_DAY","ABSENT")))))))))'), 'text'),
      fx('day_credit', W('IF(@in_service=0,0,IF(OR(@status="WFH_OD",@status="HOLIDAY",@status="HOLIDAY_WORK",@status="WEEKOFF",@status="WEEKOFF_WORK",@status="LEAVE"),1,IF(@status="UNPAID_LEAVE",0,MIN(1,@worked_credit+@leave_paid_frac))))'), 'number',
        { note: 'paid-day credit 0..1 consumed by payroll' }),
      fx('lop_days', W('IF(@in_service=0,0,ROUND(1-@day_credit,2))'), 'number'),
      fx('late_minutes', W('IF(OR(@shift_id="",@sh_flex="Y",@eff_in=0,@is_week_off=1,@is_holiday=1,@in_service=0),0,MAX(0,ROUND((@eff_in-@shift_start_dt)*1440-@sh_grace_in,0)))'), 'number'),
      fx('early_minutes', W('IF(OR(@shift_id="",@sh_flex="Y",@eff_out=0,@is_week_off=1,@is_holiday=1,@in_service=0),0,MAX(0,ROUND((@shift_end_dt-@eff_out)*1440-@sh_grace_out,0)))'), 'number'),
      fx('night_minutes', W('IF(OR(@eff_in=0,@eff_out<=@eff_in),0,ROUND(1440*(MAX(0,MIN(@eff_out,@work_date+$CFG(NIGHT_END_HOUR)/24)-MAX(@eff_in,@work_date-1+$CFG(NIGHT_START_HOUR)/24))+MAX(0,MIN(@eff_out,@work_date+1+$CFG(NIGHT_END_HOUR)/24)-MAX(@eff_in,@work_date+$CFG(NIGHT_START_HOUR)/24))),0))'), 'number'),
      fx('ot_min_regular', W('IF(OR(@ot_eligible<>"Y",@in_service=0,@is_holiday=1,@is_week_off=1,@missing_punch=1,@sh_full=0),0,MAX(0,@worked_minutes-@sh_full-@sh_ot_thr))'), 'number'),
      fx('ot_min_offday', W('IF(OR(@ot_eligible<>"Y",@in_service=0,@missing_punch=1),0,IF(OR(@is_holiday=1,@is_week_off=1),@worked_minutes,0))'), 'number'),
      fx('night_ot_minutes', W('MIN(@ot_min_regular+@ot_min_offday,@night_minutes)'), 'number'),
      fx('comp_off_eligible', W('IF(AND(OR(@status="HOLIDAY_WORK",@status="WEEKOFF_WORK"),@sh_full>0),IF(@worked_minutes>=@sh_full,1,IF(@worked_minutes>=@sh_half,0.5,0)),0)'), 'number'),
      fx('is_period_locked', W('IF(COUNTIFS([PAYROLL_CONTROL.period_start],"<="&@work_date,[PAYROLL_CONTROL.period_end],">="&@work_date,[PAYROLL_CONTROL.status],"LOCKED",[PAYROLL_CONTROL.run_type],"REGULAR")>0,1,0)'), 'number'),
      fx('exception_flag', W('IF(@in_service=0,"",IF(@missing_punch=1,"MISSING_PUNCH",IF(AND(@shift_id="",@is_holiday=0,@is_week_off=0),"NO_SHIFT",IF(AND(@worked_minutes>0,@worked_credit=0,@wfh_od=0),"SHORT_HOURS",""))))'), 'text'),
      fx('exception_open', W('IF(@exception_flag="",0,IF(COUNTIFS([ATTENDANCE_EXCEPTIONS.attendance_key],@daily_key,[ATTENDANCE_EXCEPTIONS.status],"WAIVED")>0,0,1))'), 'number'),
    ],
  },
  {
    name: 'ATTENDANCE_ADJUSTMENTS', group: 'Attendance', protection: 'FORMULA_ONLY', capacity: 3000, keyColumn: 'adjustment_id',
    purpose: 'Regularisation and corrections. Original punches are never edited; approved adjustments override the effective in/out in ATTENDANCE_DAILY.',
    columns: [
      id('adjustment_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), inp('work_date', 'date', { required: true }),
      en('adjustment_type', 'ADJUSTMENT_TYPE', { required: true }), inp('adjusted_in', 'datetime'), inp('adjusted_out', 'datetime'),
      inp('original_first_in', 'datetime'), inp('original_last_out', 'datetime'), inp('reason', 'text', { required: true }),
      inp('requested_by'), id('approver_employee_id', { required: false }), inp('decided_at', 'datetime'), inp('decided_by'), inp('decision_note'),
      ...aud('APPROVAL_STATUS'),
      fx('attendance_key', 'IF(@adjustment_id="","",@employee_id&":"&@work_date)', 'text'),
      fx('is_period_locked', 'IF(@adjustment_id="","",IF(COUNTIFS([PAYROLL_CONTROL.period_start],"<="&@work_date,[PAYROLL_CONTROL.period_end],">="&@work_date,[PAYROLL_CONTROL.status],"LOCKED",[PAYROLL_CONTROL.run_type],"REGULAR")>0,1,0))', 'number'),
      fx('locked_violation', 'IF(@adjustment_id="","",IF(AND(@is_period_locked=1,@status="APPROVED",@decided_at>MAXIFS([PAYROLL_CONTROL.locked_at],[PAYROLL_CONTROL.period_start],"<="&@work_date,[PAYROLL_CONTROL.period_end],">="&@work_date,[PAYROLL_CONTROL.status],"LOCKED")),1,0))', 'number', { note: 'approved after the covering period was locked' }),
    ],
  },
  {
    name: 'ATTENDANCE_EXCEPTIONS', group: 'Attendance', protection: 'FORMULA_ONLY', capacity: 3000, keyColumn: 'exception_id',
    purpose: 'Registry of missing punches, unusual hours and unresolved conflicts detected from ATTENDANCE_DAILY.exception_flag. WAIVED entries stop blocking payroll.',
    columns: [
      id('exception_id'), inp('attendance_key', 'text', { required: true }), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), inp('work_date', 'date'),
      inp('exception_type'), inp('detected_at', 'datetime'), inp('resolution_note'), inp('resolved_by'), inp('resolved_at', 'datetime'), ...aud('EXCEPTION_STATUS'),
      fx('still_flagged', 'IF(@exception_id="","",$LKD(ATTENDANCE_DAILY.exception_flag,ATTENDANCE_DAILY.daily_key,@attendance_key,""))', 'text'),
    ],
  },
  {
    name: 'OVERTIME', group: 'Attendance', protection: 'FORMULA_ONLY', capacity: 3000, keyColumn: 'ot_id',
    purpose: 'OT requests and approvals. payable_minutes = MIN(approved, formula-calculated OT) so payroll never pays more than attendance supports.',
    columns: [
      id('ot_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), inp('work_date', 'date', { required: true }), en('day_type', 'OT_DAY_TYPE', { required: true }),
      inp('requested_minutes', 'number'), inp('reason'), id('approver_employee_id', { required: false }), inp('approved_minutes', 'number'),
      inp('decided_at', 'datetime'), inp('decided_by'), inp('decision_note'), ...aud('APPROVAL_STATUS'),
      fx('daily_key', 'IF(@ot_id="","",@employee_id&":"&@work_date)', 'text'),
      fx('ad_row', 'IF(@ot_id="","",IFERROR(MATCH(@daily_key,[ATTENDANCE_DAILY.daily_key],0),0))', 'number'),
      fx('calc_minutes', 'IF(@ot_id="","",IF(@ad_row=0,0,IF(@day_type="OFFDAY",INDEX([ATTENDANCE_DAILY.ot_min_offday],@ad_row),INDEX([ATTENDANCE_DAILY.ot_min_regular],@ad_row))))', 'number'),
      fx('payable_minutes', 'IF(@ot_id="","",IF(@status="APPROVED",MIN(@approved_minutes,@calc_minutes),0))', 'number'),
      fx('payable_night_minutes', 'IF(@ot_id="","",IF(@status="APPROVED",IF(@ad_row=0,0,MIN(@payable_minutes,INDEX([ATTENDANCE_DAILY.night_ot_minutes],@ad_row))),0))', 'number'),
      fx('is_period_locked', 'IF(@ot_id="","",IF(COUNTIFS([PAYROLL_CONTROL.period_start],"<="&@work_date,[PAYROLL_CONTROL.period_end],">="&@work_date,[PAYROLL_CONTROL.status],"LOCKED",[PAYROLL_CONTROL.run_type],"REGULAR")>0,1,0))', 'number'),
    ],
  },
  {
    name: 'TIMESHEETS', group: 'Attendance', protection: 'FORMULA_ONLY', capacity: 10000, keyColumn: 'timesheet_id',
    purpose: 'Project / task time where enabled, reconciled against attendance worked hours.',
    columns: [
      id('timesheet_id'), id('employee_id', { ref: 'EMPLOYEES.employee_id' }), inp('work_date', 'date', { required: true }), inp('project_code', 'text', { required: true }),
      inp('task'), inp('hours', 'number', { required: true }), en('billable', 'YN'), id('approver_employee_id', { required: false }),
      inp('decided_at', 'datetime'), inp('decided_by'), ...aud('APPROVAL_STATUS'),
      fx('daily_total_hours', 'IF(@timesheet_id="","",SUMIFS([TIMESHEETS.hours],[TIMESHEETS.employee_id],@employee_id,[TIMESHEETS.work_date],@work_date,[TIMESHEETS.status],"<>REJECTED"))', 'number'),
      fx('attendance_hours', 'IF(@timesheet_id="","",ROUND($LKD(ATTENDANCE_DAILY.worked_minutes,ATTENDANCE_DAILY.daily_key,@employee_id&":"&@work_date,0)/60,2))', 'number'),
      fx('variance_flag', 'IF(@timesheet_id="","",IF(@daily_total_hours>@attendance_hours+0.5,"EXCEEDS_ATTENDANCE","OK"))', 'text'),
    ],
  },
];
