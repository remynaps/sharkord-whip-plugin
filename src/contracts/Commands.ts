type Commands = {
  whip_start: {
    args: Record<string, never>;
    response: string;
  };
  whip_stop: {
    args: Record<string, never>;
    response: string;
  };
};

export type { Commands };
