import {useEffect} from 'react';
export function useMotionSettings(reduced=true){useEffect(()=>{document.documentElement.classList.toggle('reduced-motion',reduced);document.documentElement.classList.toggle('motion-enabled',!reduced);return()=>{document.documentElement.classList.remove('motion-enabled');document.documentElement.classList.add('reduced-motion');};},[reduced]);}
