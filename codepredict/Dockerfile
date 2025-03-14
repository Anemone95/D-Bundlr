FROM nvidia/cuda:11.8.0-devel-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    ca-certificates \
    vim \
    htop \
    sudo \
    fio \
    python3\
    python3-pip\
    python3-venv\
    gcc \
    build-essential \
    python3-dev \
    less\
    openssh-client \
    openssh-server \
    tmux\
    tar\
    pigz\
    sed\
    libglib2.0-dev libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpangocairo-1.0-0\
    zsh git screen unzip psmisc &&\
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/                                                

RUN wget https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -O /tmp/miniconda.sh && \
    bash /tmp/miniconda.sh -b -p /opt/conda && \
    rm /tmp/miniconda.sh

ENV PATH="/opt/conda/bin:$PATH"

COPY . /codepredict
WORKDIR /codepredict

RUN conda env create -f /codepredict/environment-gpu.yml && conda clean -a

ENV CONDA_DEFAULT_ENV=ml
ENV PATH="/opt/conda/envs/ml/bin:$PATH"

COPY ./docker/entrypoint.sh /entrypoint.sh


SHELL ["conda", "run", "-n", "ml", "/bin/zsh", "-c"]