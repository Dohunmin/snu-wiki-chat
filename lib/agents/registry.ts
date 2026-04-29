import type { AgentPlugin, AgentType } from './types';
import type { AgentConfig } from './types';
import { WikiAgent } from './wiki-agent';
import agentsConfig from '@/data/agents.config.json';

class AgentRegistry {
  private agents: Map<string, AgentPlugin> = new Map();
  private initialized = false;

  private init() {
    if (this.initialized) return;
    for (const config of agentsConfig.agents) {
      if (!config.enabled) continue;
      const agentConfig = config as AgentConfig;
      if (agentConfig.type === 'wiki') {
        this.register(new WikiAgent(agentConfig));
      }
      // 향후 'task' 타입 에이전트는 여기에 추가
    }
    this.initialized = true;
  }

  register(agent: AgentPlugin): void {
    this.agents.set(agent.config.id, agent);
  }

  unregister(id: string): void {
    this.agents.delete(id);
  }

  getAll(): AgentPlugin[] {
    this.init();
    return Array.from(this.agents.values());
  }

  getById(id: string): AgentPlugin | undefined {
    this.init();
    return this.agents.get(id);
  }

  getByType(type: AgentType): AgentPlugin[] {
    this.init();
    return this.getAll().filter(a => a.config.type === type);
  }
}

export const registry = new AgentRegistry();
