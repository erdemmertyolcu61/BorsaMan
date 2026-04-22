export default function MainLayout({ left, center, right }) {
  return (
    <div className="main">
      <div className="pan">{left}</div>
      <div className="pan center">{center}</div>
      <div className="pan">{right}</div>
    </div>
  );
}
