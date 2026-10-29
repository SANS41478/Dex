import { Composer } from '../components/layout/Composer'
import { ConversationView } from '../components/layout/ConversationView'

export function ChatPanel() {
  return (
    <section className="workspace-panel" data-testid="panel-chat">
      <ConversationView />
      <Composer />
    </section>
  )
}
