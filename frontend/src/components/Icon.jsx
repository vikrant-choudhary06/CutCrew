// One stroke icon set, 24px grid.
const paths = {
  home: <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1Z" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  list: <><path d="M5 7h10M5 12h10M5 17h6" /><path d="M18 14v6M15 17h6" /></>,
  user: <><circle cx="12" cy="8.5" r="3.8" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  play: <path d="M8 5.5v13l11-6.5Z" fill="currentColor" stroke="none" />,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.8v.4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12.5 4.2 4.2L19 7" />,
  close: <path d="m6.5 6.5 11 11m0-11-11 11" />,
  left: <path d="m14.5 6-6 6 6 6" />,
  right: <path d="m9.5 6 6 6-6 6" />,
  bolt: <path d="M13 3 5.5 13.2h5.6L10 21l8-11h-5.7Z" fill="currentColor" stroke="none" />,
  star: <path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8Z" fill="currentColor" stroke="none" />,
  back: <path d="M19 12H6m5-6-6 6 6 6" />,
  film: <><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4" /></>,
  tv: <><rect x="3.5" y="5.5" width="17" height="11" rx="2" /><path d="M9 20h6M12 16.5V20" /></>,
}

export default function Icon({ name, size = 20, ...props }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{paths[name]}</svg>
}
