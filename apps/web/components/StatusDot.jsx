const TONES = {
  green: 'bg-leaf',
  amber: 'bg-amber',
  red: 'bg-red-600',
  gray: 'bg-mist',
}

// Status as a dot + plain word — no filled pills.
export default function StatusDot({ status, tone }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className={`w-2 h-2 rounded-full ${TONES[tone] || TONES.gray}`} />
      {status}
    </span>
  )
}

// Stage tone for deals: won = green, lost = red, open stages = neutral.
export function stageTone(stageType) {
  if (stageType === 'won') return 'green'
  if (stageType === 'lost') return 'red'
  return 'gray'
}
