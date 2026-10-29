import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/domains/api/client";

export interface Campaign {
  id: string;
  name: string;
  type: string;
  status: "active" | "paused" | "draft";
  settings: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export function useCampaigns() {
  return useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api.campaigns.list() as Promise<Campaign[]>,
    staleTime: Infinity,
  });
}

export function useCreateCampaign() {
  const queryClient = useQueryClient();
  return useMutation<Campaign, Error, { name: string; type: string; status: Campaign["status"]; settings: Record<string, unknown> | null }>({
    mutationFn: async ({ name, type, status, settings }) => {
      return api.campaigns.create({ name, type, status, settings });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });
}

export function useUpdateCampaign() {
  const queryClient = useQueryClient();
  return useMutation<Campaign, Error, Partial<Pick<Campaign, "name" | "type" | "status" | "settings">> & { id: string }>({
    mutationFn: async ({ id, ...updates }) => {
      return api.campaigns.update(id, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });
}
