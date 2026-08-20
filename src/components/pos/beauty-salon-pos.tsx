'use client';

import { Sparkles } from 'lucide-react';
import { GenericPos, type PosProps } from './generic-pos';

export const BeautySalonPos = (props: PosProps) => {
    return <GenericPos {...props} productIcon={<Sparkles className="h-8 w-8 text-muted-foreground" data-ai-hint="beauty salon product" />} />;
}
