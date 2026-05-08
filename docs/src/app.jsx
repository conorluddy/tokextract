// app.jsx — page composition + mount.

function TokextractPage() {
  return (
    <div className="vt-page">
      <Bar />
      <Hero />
      <What />
      <Install />
      <Categories />
      <Validation />
      <Sample />
      <Pipeline />
      <Roadmap />
      <Footer />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<TokextractPage />);
