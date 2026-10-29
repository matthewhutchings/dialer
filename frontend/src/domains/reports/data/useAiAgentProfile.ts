import { useQuery } from "@tanstack/react-query";
import { api } from "@/domains/api/client";

export const AI_AGENT_PROFILE_KEY = ["ai-agent-profile"];

export function useAiAgentProfile(enabled = true) {
  return useQuery({
    queryKey: AI_AGENT_PROFILE_KEY,
    queryFn: api.aiCalls.profile,
    enabled,
    staleTime: 30_000,
  });
}
