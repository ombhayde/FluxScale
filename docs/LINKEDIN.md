# LinkedIn announcement draft

I built FluxScale: a self-hosted autoscaling controller with user-specific project analysis.

In this recorded local demo, I sent 1,00,000 application requests through a real
Docker deployment: 1,00,000 succeeded, 0 failed.
The workload mixes database reads, POST writes, five-table PostgreSQL joins and CPU work.
The controller added actual containers from 1 to 6 healthy replicas, then drained and
scaled back to 1 after traffic stopped.

The recording also shows two separate user accounts. Each sees only their own
project's live traffic, workload latency, errors, containers and scaling history.

Rust controller + HTTP proxy · Node/Express telemetry SDK · React dashboard.
The repository includes Docker setup, application integration instructions,
account/project isolation checks and the measured demo analysis.

I ramped the offered load target to 100,000 RPS and measured actual throughput
and unsent demand separately. This is a controlled local workload, not a claim of
100,000 successful RPS or cloud production certification. Developers can integrate
the supported self-hosted path with their own stateless Dockerized HTTP application.

Code, measured results and integration guide: https://github.com/ombhayde/FluxScale

#Rust #Docker #NodeJS #React #OpenSource #Autoscaling

Attachment: artifacts/demo/fluxscale-demo.mp4
