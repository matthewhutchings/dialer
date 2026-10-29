export type AiSentiment = "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "MIXED";

export interface CallQualityScores {
  /** 1-5 each: conversion likelihood, agent politeness/rapport, discovery questions, prospect engagement, prospect sentiment. */
  conversion: number;
  politeness: number;
  questioning: number;
  engagement: number;
  sentiment: number;
}

/** A follow-up the caller or prospect actually agreed to on the call. */
export interface FollowUpTask {
  title: string;
  description: string;
  /** ISO timestamp, only when a day or time was stated on the call. */
  dueAt: string | null;
}

export interface CallAnalysis {
  summary: string;
  sentiment: AiSentiment;
  /** 0-100: how well the call went for the prospect. */
  score: number;
  scores: CallQualityScores;
  keyPoints: string[];
  tasks: FollowUpTask[];
  /** 0-1: model self-reported confidence. */
  confidence: number;
  model: string;
}
