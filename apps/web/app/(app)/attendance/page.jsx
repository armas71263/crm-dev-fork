import { bffFetch } from '../../../src/lib/bff.js'
import DataTable from '../../../components/DataTable.jsx'

// Attendance (hr_events) — the template's team module. Weekly presence per
// employee: present/absent/late/leave days.
export default async function AttendancePage() {
  const { attendance } = await bffFetch('/data/attendance')
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Attendance</h1>
        <p className="text-[14px] text-steel mt-1">Weekly presence by employee and department.</p>
      </header>
      <DataTable
        rows={attendance}
        columns={[
          { key: 'employee', label: 'Employee', render: (r) => <span className="font-medium">{r.employee}</span> },
          { key: 'department', label: 'Department' },
          { key: 'week', label: 'Week' },
          { key: 'present', label: 'Present', render: (r) => <span className="text-right block">{r.present}</span> },
          { key: 'absent', label: 'Absent', render: (r) => <span className="text-right block">{r.absent}</span> },
          { key: 'late', label: 'Late', render: (r) => <span className="text-right block">{r.late}</span> },
          { key: 'leave', label: 'Leave', render: (r) => <span className="text-right block">{r.leave}</span> },
        ]}
      />
    </div>
  )
}
