import { useState } from 'react'
import { Modal, useToast } from '../components/ui.jsx'
import { updateClassroomSettings } from '../features/shared/services/lmsService'

const STREAM_PERMISSIONS = [
  { value: 'teachers_only', label: 'Only teachers can post' },
  { value: 'comment_only', label: 'Teachers post, students can comment' },
  { value: 'post_and_comment', label: 'Students can post and comment' },
]

export default function ClassroomSettingsModal({ classroom, open, onClose, onSaved }) {
  const toast = useToast()
  const settings = classroom.settings || {}
  const [requireApproval, setRequireApproval] = useState(Boolean(settings.require_approval))
  const [streamPermission, setStreamPermission] = useState(settings.stream_permission || 'comment_only')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      const updated = await updateClassroomSettings(classroom.id, { requireApproval, streamPermission })
      onSaved(updated)
      toast.success('Class settings saved.')
      onClose()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Class settings"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <input
          type="checkbox"
          checked={requireApproval}
          onChange={(e) => setRequireApproval(e.target.checked)}
        />
        Require my approval for new students to join
      </label>

      <div>
        <div className="tiny" style={{ marginBottom: 6 }}>Who can post to the class stream</div>
        <select
          className="select"
          value={streamPermission}
          onChange={(e) => setStreamPermission(e.target.value)}
        >
          {STREAM_PERMISSIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    </Modal>
  )
}
