import { useState } from 'react';

export function useLinkedDimensions(initialX: number, initialY: number) {
  const [x, setX] = useState(initialX);
  const [y, setY] = useState(initialY);
  const [linked, setLinked] = useState(true);
  const [ratio, setRatio] = useState(1);

  const toggle = () => {
    if (!linked) setRatio(x > 0 ? y / x : 1);
    setLinked((value) => !value);
  };
  const updateX = (value: number) => {
    const next = Math.max(0.01, value || 0.01);
    setX(next);
    if (linked) setY(Math.max(0.01, next * ratio));
  };
  const updateY = (value: number) => {
    const next = Math.max(0.01, value || 0.01);
    setY(next);
    if (linked) setX(Math.max(0.01, next / (ratio || 1)));
  };

  return { x, y, setX, setY, linked, toggle, updateX, updateY };
}
